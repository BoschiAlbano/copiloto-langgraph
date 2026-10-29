import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/graph/index.js";
import type { AgentModel } from "../src/graph/nodes/agent.js";
import type { RouterModel } from "../src/graph/nodes/router.js";
import { continueTurn, runTurn, ThreadPendingError } from "../src/graph/run-turn.js";
import { getStatus } from "../src/graph/threads.js";
import { checkpointsUrl, openCheckpointing } from "./helpers/checkpointing.js";
import { unexpectedActions } from "./helpers/graph.js";
import { echoModel, toolCall } from "./helpers/models.js";
import { TestThreads } from "./helpers/threads.js";

// CA4: un turno que se corta a la mitad se puede retomar sin repetir ni duplicar nada.
let toolRuns = 0;
const countTurns = tool(
  async () => {
    toolRuns++;
    return JSON.stringify({ total: 7 });
  },
  { name: "countTurns", description: "Cuenta turnos", schema: z.strictObject({}) },
);

/** Modelo que falla (como una API caída) en las llamadas indicadas y responde con el guion en las demás. */
function flakyModel(failOn: number[], script: (n: number) => AIMessage) {
  let calls = 0;
  const model: AgentModel = {
    async invoke() {
      const n = calls++;
      if (failOn.includes(n)) throw new Error("529 Overloaded");
      return script(n);
    },
  };
  return model;
}

function flakyRouter(failOnCalls: number[]) {
  let calls = 0;
  const model: RouterModel = {
    async invoke() {
      if (failOnCalls.includes(calls++)) throw new Error("529 Overloaded");
      return { parsed: { reason: "consulta", intent: "query" } };
    },
  };
  return model;
}

const threads = new TestThreads();
afterAll(async () => {
  const cp = openCheckpointing();
  await threads.cleanup(cp.saver);
  await cp.close();
});

describe.skipIf(!checkpointsUrl)("turno a medias", () => {
  it("falla el router: el hilo queda esperando al router y continueTurn lo termina sin duplicar", async () => {
    const id = threads.fresh();
    const cp = openCheckpointing();
    const graph = buildGraph({
      models: {
        router: flakyRouter([0]),
        agent: flakyModel([], () => new AIMessage("Hay 7 turnos.")),
        action: echoModel().model,
        chat: echoModel().model,
        clarify: echoModel().model,
      },
      tools: [countTurns],
      actions: unexpectedActions,
      checkpointer: cp.saver,
    });

    await expect(runTurn({ graph }, id, "¿Cuántos turnos hay?")).rejects.toThrow(/529/);

    const pending = await getStatus(graph, id);
    expect(pending).toMatchObject({ exists: true, pending: true, next: ["router"] });
    expect(pending.messages.map((m) => m.text)).toEqual(["¿Cuántos turnos hay?"]);

    const turn = await continueTurn({ graph }, id);
    expect(turn.reply).toBe("Hay 7 turnos.");
    expect(turn.route.intent).toBe("query");

    const done = await getStatus(graph, id);
    expect(done.pending).toBe(false);
    expect(done.messages.map((m) => m.type)).toEqual(["human", "ai"]); // un mensaje de la persona y una respuesta
    await cp.close();
  });

  it("falla el agente después de ejecutar la herramienta: al continuar no se repite la herramienta, ni tras reiniciar", async () => {
    const id = threads.fresh();
    toolRuns = 0;
    // Cada "programa" tiene su propio modelo, con su propio contador de llamadas.
    const build = (
      saver: ReturnType<typeof openCheckpointing>["saver"],
      failOn: number[],
      script: (n: number) => AIMessage,
    ) =>
      buildGraph({
        models: {
          router: flakyRouter([]),
          agent: flakyModel(failOn, script),
          action: echoModel().model,
          chat: echoModel().model,
          clarify: echoModel().model,
        },
        tools: [countTurns],
        actions: unexpectedActions,
        checkpointer: saver,
      });

    // Primer "programa": el agente pide la herramienta, la herramienta corre y la segunda llamada al agente falla.
    const first = openCheckpointing();
    const graphA = build(first.saver, [1], (n) => (n === 0 ? toolCall("c1", "countTurns") : new AIMessage("no debería llegar")));
    await expect(runTurn({ graph: graphA }, id, "¿Cuántos turnos hay?")).rejects.toThrow(/529/);
    expect(toolRuns).toBe(1);
    await first.close(); // el programa se cierra con el turno a medias

    // Segundo "programa": ve el hilo a medias y lo termina.
    const second = openCheckpointing();
    const graphB = build(second.saver, [], () => new AIMessage("Hay 7 turnos."));
    const pending = await getStatus(graphB, id);
    expect(pending).toMatchObject({ pending: true, next: ["agent"] });
    // Ya están la pregunta, el pedido de herramienta y su resultado: lo único que falta es la respuesta final.
    expect(pending.messages.map((m) => m.type)).toEqual(["human", "ai", "tool"]);

    const turn = await continueTurn({ graph: graphB }, id);
    expect(turn.reply).toBe("Hay 7 turnos.");
    expect(toolRuns).toBe(1); // la herramienta no se volvió a ejecutar

    const done = await graphB.getState({ configurable: { thread_id: id } });
    expect(done.next).toEqual([]);
    const all = done.values.messages as BaseMessage[];
    expect(all.map((m) => m.type)).toEqual(["human", "ai", "tool", "ai"]);
    expect(HumanMessage.isInstance(all[0])).toBe(true);
    expect(ToolMessage.isInstance(all[2])).toBe(true);
    await second.close();
  });

  it("un mensaje nuevo en un hilo a medias se rechaza y no se guarda", async () => {
    const id = threads.fresh();
    const cp = openCheckpointing();
    const graph = buildGraph({
      models: {
        router: flakyRouter([0]),
        agent: flakyModel([], () => new AIMessage("ok")),
        action: echoModel().model,
        chat: echoModel().model,
        clarify: echoModel().model,
      },
      tools: [countTurns],
      actions: unexpectedActions,
      checkpointer: cp.saver,
    });
    await expect(runTurn({ graph }, id, "primera")).rejects.toThrow(/529/);

    await expect(runTurn({ graph }, id, "segunda")).rejects.toBeInstanceOf(ThreadPendingError);
    const status = await getStatus(graph, id);
    expect(status.messages.map((m) => m.text)).toEqual(["primera"]); // la segunda no entró

    await continueTurn({ graph }, id);
    await expect(runTurn({ graph }, id, "ahora sí")).resolves.toMatchObject({ reply: "ok" });
    await cp.close();
  });

  it("si se alcanza el tope de pasos el hilo queda a medias y se puede seguir con otros 12 pasos", async () => {
    const id = threads.fresh();
    const cp = openCheckpointing();
    // Pide herramientas 8 veces (16 pasos con las herramientas, más de lo que permite un solo intento) y recién responde.
    const graph = buildGraph({
      models: {
        router: flakyRouter([]),
        agent: flakyModel([], (n) => (n < 8 ? toolCall(`c${n}`, "countTurns") : new AIMessage("Listo."))),
        action: echoModel().model,
        chat: echoModel().model,
        clarify: echoModel().model,
      },
      tools: [countTurns],
      actions: unexpectedActions,
      checkpointer: cp.saver,
    });

    await expect(runTurn({ graph }, id, "insistente")).rejects.toMatchObject({ name: "GraphRecursionError" });
    expect((await getStatus(graph, id)).pending).toBe(true);

    const turn = await continueTurn({ graph }, id);
    expect(turn.reply).toBe("Listo.");
    expect((await getStatus(graph, id)).pending).toBe(false);
    await cp.close();
  });
});
