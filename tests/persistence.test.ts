import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { afterAll, describe, expect, it } from "vitest";
import type { Intent } from "../src/graph/intents.js";
import { runTurn } from "../src/graph/run-turn.js";
import { getHistory, getStatus } from "../src/graph/threads.js";
import { checkpointsUrl, openCheckpointing } from "./helpers/checkpointing.js";
import { buildTestGraph } from "./helpers/graph.js";
import { echoModel, scriptedModel, toolCall } from "./helpers/models.js";
import { TestThreads } from "./helpers/threads.js";

// Requiere Postgres con el esquema `langgraph` (npm run db:reset). Los modelos son falsos: no cuesta nada.
const countTurns = tool(async () => JSON.stringify({ total: 7 }), {
  name: "countTurns",
  description: "Cuenta turnos",
  schema: z.strictObject({}),
});

const threads = new TestThreads();
afterAll(async () => {
  const cp = openCheckpointing();
  await threads.cleanup(cp.saver);
  await cp.close();
});

describe.skipIf(!checkpointsUrl)("persistencia de hilos", () => {
  describe("CA1: retomar tras reiniciar", () => {
    it("el segundo turno, con todo reabierto, recibe el historial del primero", async () => {
      const id = threads.fresh();

      // Primer "programa": un turno y se cierra todo.
      const first = openCheckpointing();
      const modelA = echoModel();
      await runTurn(
        { graph: buildTestGraph({ model: modelA.model, tools: [], intent: "chat", checkpointer: first.saver }) },
        id,
        "Hola, soy Ana",
      );
      await first.close();

      // Segundo "programa": conexión, grafo y modelo nuevos.
      const second = openCheckpointing();
      const modelB = echoModel();
      const graph = buildTestGraph({ model: modelB.model, tools: [], intent: "chat", checkpointer: second.saver });
      const turn = await runTurn({ graph }, id, "¿Te acordás de mí?");

      const seen = modelB.calls[0]!.map((m) => m.text);
      expect(seen).toContain("Hola, soy Ana");
      expect(seen).toContain("eco: Hola, soy Ana");
      expect(seen.at(-1)).toBe("¿Te acordás de mí?");
      expect(turn.reply).toBe("eco: ¿Te acordás de mí?");

      const status = await getStatus(graph, id);
      expect(status.messages.map((m) => m.text)).toEqual([
        "Hola, soy Ana",
        "eco: Hola, soy Ana",
        "¿Te acordás de mí?",
        "eco: ¿Te acordás de mí?",
      ]);
      await second.close();
    });

    it("los mensajes vuelven como mensajes de LangChain, con sus llamadas a herramientas intactas", async () => {
      const id = threads.fresh();
      const first = openCheckpointing();
      const script = scriptedModel([toolCall("c1", "countTurns"), new AIMessage("Hay 7.")]);
      await runTurn(
        { graph: buildTestGraph({ model: script.model, tools: [countTurns], checkpointer: first.saver }) },
        id,
        "¿Cuántos turnos?",
      );
      await first.close();

      const second = openCheckpointing();
      const modelB = scriptedModel([new AIMessage("Eran 7.")]);
      const graph = buildTestGraph({ model: modelB.model, tools: [countTurns], checkpointer: second.saver });
      await runTurn({ graph }, id, "¿Y cuántos eran?");

      const received = modelB.calls[0]!.slice(1); // sin el prompt del sistema
      expect(received.map((m) => m.type)).toEqual(["human", "ai", "tool", "ai", "human"]);
      const ai = received[1] as AIMessage;
      expect(AIMessage.isInstance(ai)).toBe(true);
      expect(ai.tool_calls?.[0]).toMatchObject({ id: "c1", name: "countTurns" });
      const toolMessage = received[2] as ToolMessage;
      expect(ToolMessage.isInstance(toolMessage)).toBe(true);
      expect(toolMessage.tool_call_id).toBe("c1");
      expect(JSON.parse(toolMessage.text)).toEqual({ total: 7 });
      expect(HumanMessage.isInstance(received[0])).toBe(true);
      await second.close();
    });

    it("un hilo que nunca existió empieza vacío", async () => {
      const cp = openCheckpointing();
      const graph = buildTestGraph({ model: echoModel().model, tools: [], checkpointer: cp.saver });
      expect(await getStatus(graph, threads.fresh())).toEqual({ exists: false, pending: false, next: [], messages: [] });
      await cp.close();
    });
  });

  describe("CA2: los hilos no se mezclan", () => {
    it("dos hilos intercalados guardan solo sus propios mensajes", async () => {
      const [a, b] = [threads.fresh("a"), threads.fresh("b")] as const;
      const cp = openCheckpointing();
      const model = echoModel();
      const graph = buildTestGraph({ model: model.model, tools: [], intent: "chat", checkpointer: cp.saver });

      await runTurn({ graph }, a, "secreto-de-A uno");
      await runTurn({ graph }, b, "secreto-de-B uno");
      await runTurn({ graph }, a, "secreto-de-A dos");
      await runTurn({ graph }, b, "secreto-de-B dos");

      const textOf = async (id: string) => (await getStatus(graph, id)).messages.map((m) => m.text).join(" | ");
      const [inA, inB] = [await textOf(a), await textOf(b)];
      expect(inA).toContain("secreto-de-A uno");
      expect(inA).toContain("secreto-de-A dos");
      expect(inA).not.toContain("secreto-de-B");
      expect(inB).not.toContain("secreto-de-A");
      expect((await getStatus(graph, a)).messages).toHaveLength(4);

      // Lo que recibió el modelo en cada llamada tampoco mezcla hilos.
      for (const call of model.calls) {
        const all = call.map((m) => m.text).join(" | ");
        expect(all.includes("secreto-de-A") && all.includes("secreto-de-B"), all).toBe(false);
      }
      await cp.close();
    });
  });

  describe("CA3: historial de checkpoints", () => {
    const paths: [Intent, string[]][] = [
      ["query", ["__start__", "router", "agent", "tools", "agent"]],
      ["chat", ["__start__", "router", "chat"]],
      ["unclear", ["__start__", "router", "clarify"]],
      ["action", ["__start__", "router", "action_agent"]],
      ["report", ["__start__", "router", "report_stub"]],
    ];
    for (const [intent, expected] of paths) {
      it(`la ruta ${intent} deja un checkpoint por paso, con la secuencia de nodos esperada`, async () => {
        const id = threads.fresh();
        const cp = openCheckpointing();
        const model = intent === "query" ? scriptedModel([toolCall("c1", "countTurns"), new AIMessage("Hay 7.")]) : echoModel();
        const graph = buildTestGraph({ model: model.model, tools: [countTurns], intent, checkpointer: cp.saver });
        await runTurn({ graph }, id, "pedido");

        const history = await getHistory(graph, id); // del más nuevo al más viejo
        const oldestFirst = [...history].reverse();
        expect(oldestFirst[0]).toMatchObject({ source: "input", step: -1 });
        expect(oldestFirst.slice(1).flatMap((c) => c.ranNodes)).toEqual(expected);
        expect(history).toHaveLength(expected.length + 1);
        expect(history[0]!.next).toEqual([]); // el último checkpoint es el del final del turno
        expect(history.map((c) => c.step)).toEqual([...history.map((c) => c.step)].sort((x, y) => y - x));
        expect(history.at(-1)!.messageCount).toBe(0);
        expect(history[0]!.intent).toBe(intent);
        await cp.close();
      });
    }

    it("un segundo turno agrega checkpoints al mismo hilo, sin borrar los anteriores", async () => {
      const id = threads.fresh();
      const cp = openCheckpointing();
      const graph = buildTestGraph({ model: echoModel().model, tools: [], intent: "chat", checkpointer: cp.saver });
      await runTurn({ graph }, id, "uno");
      const afterOne = (await getHistory(graph, id)).length;
      await runTurn({ graph }, id, "dos");
      const history = await getHistory(graph, id);
      expect(history).toHaveLength(afterOne * 2);
      expect(history[0]!.messageCount).toBe(4);
      await cp.close();
    });
  });
});
