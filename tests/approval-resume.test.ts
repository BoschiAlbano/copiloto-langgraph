import { AIMessage } from "@langchain/core/messages";
import { afterAll, describe, expect, it } from "vitest";
import type { HumanDecision } from "../src/graph/approval.js";
import {
  continueTurn,
  NothingToDecideError,
  resumeTurn,
  runTurn,
  ThreadAwaitingApprovalError,
  ThreadPendingError,
} from "../src/graph/run-turn.js";
import { getStatus, listThreads } from "../src/graph/threads.js";
import { fakeActions } from "./helpers/actions.js";
import { checkpointsUrl, openCheckpointing } from "./helpers/checkpointing.js";
import { buildTestGraph } from "./helpers/graph.js";
import { echoModel, scriptedModel, toolCall } from "./helpers/models.js";
import { TestThreads } from "./helpers/threads.js";

// Aprobación sobre Postgres real (solo el esquema de hilos) con un ejecutor falso: lo que se prueba es que la
// pausa, la decisión y la reanudación sobreviven a reiniciar el programa. Los efectos en la base de negocio se
// prueban en tests/writes/.

const threads = new TestThreads();
afterAll(async () => {
  const cp = openCheckpointing();
  await threads.cleanup(cp.saver);
  await cp.close();
});

/** Un "programa": conexión, modelos y grafo nuevos. Se cierra con `close()` para simular que el proceso termina. */
function program(script: AIMessage[], actions = fakeActions()) {
  const cp = openCheckpointing();
  const action = scriptedModel(script);
  const graph = buildTestGraph({
    model: echoModel().model,
    actionModel: action.model,
    tools: [],
    actions: actions.runner,
    intent: "action",
    checkpointer: cp.saver,
  });
  return { agent: { graph }, cp, graph, actions, action, close: () => cp.close() };
}

const cancel = () => toolCall("toolu_1", "cancelAppointment", { appointmentId: 7 });
const approve: HumanDecision = { decision: "approve" };

describe.skipIf(!checkpointsUrl)("aprobación sobre hilos guardados", () => {
  it("runTurn devuelve la propuesta y no una respuesta; el hilo queda esperando", async () => {
    const id = threads.fresh();
    const p = program([cancel(), new AIMessage("Listo.")]);
    const turn = await runTurn(p.agent, id, "Cancelá el turno 7");

    expect(turn.reply).toBe("");
    expect(turn.awaiting?.action).toMatchObject({ id: `${id}:toolu_1`, tool: "cancelAppointment", params: { appointmentId: 7 } });
    expect(turn.summary.actions).toEqual([]); // todavía no se decidió nada
    expect(p.actions.execute).not.toHaveBeenCalled();

    const status = await getStatus(p.graph, id);
    expect(status.awaiting?.action.id).toBe(`${id}:toolu_1`);
    expect(status.pending).toBe(false); // esperar una decisión no es una falla
    await p.close();
  });

  it("CA5: un hilo pausado sobrevive a reiniciar, se puede aprobar después y se ejecuta una sola vez", async () => {
    const id = threads.fresh();

    // Primer programa: propone y se cierra.
    const first = program([cancel()]);
    const proposed = await runTurn(first.agent, id, "Cancelá el turno 7");
    await first.close();

    // Segundo programa: todo nuevo. La tarjeta se reconstruye del estado guardado.
    const second = program([new AIMessage("Listo, el turno quedó cancelado.")]);
    const status = await getStatus(second.graph, id);
    expect(status.awaiting).toEqual(proposed.awaiting);
    expect((await listThreads({ pool: second.cp.pool, graph: second.graph }, 200)).find((t) => t.threadId === id)).toMatchObject({
      awaiting: true,
      pending: false,
    });

    // Mientras espera, ni un mensaje nuevo ni continuar a ciegas: hay que decidir.
    await expect(runTurn(second.agent, id, "otra cosa")).rejects.toBeInstanceOf(ThreadAwaitingApprovalError);
    await expect(continueTurn(second.agent, id)).rejects.toBeInstanceOf(ThreadAwaitingApprovalError);
    expect(second.action.calls).toHaveLength(0);

    const done = await resumeTurn(second.agent, id, approve);
    expect(done.awaiting).toBeUndefined();
    expect(done.reply).toBe("Listo, el turno quedó cancelado.");
    expect(done.summary.actions).toEqual([{ tool: "cancelAppointment", ok: true, message: expect.stringContaining("Hecho: cancelAppointment") }]);
    expect(second.actions.executed).toHaveLength(1);
    expect(second.actions.executed[0]).toMatchObject({ threadId: id, actionId: `${id}:toolu_1`, decision: "approved" });
    await second.close();

    // Tercer programa: el hilo ya está completo y no hay nada más para decidir.
    const third = program([]);
    const final = await getStatus(third.graph, id);
    expect(final).toMatchObject({ pending: false, next: [] });
    expect(final.awaiting).toBeUndefined();
    await expect(resumeTurn(third.agent, id, approve)).rejects.toBeInstanceOf(NothingToDecideError);
    await third.close();
  });

  it("rechazar y editar también funcionan tras reiniciar", async () => {
    for (const [decision, expected] of [
      [{ decision: "reject", comment: "no" } as HumanDecision, { decision: "rejected", comment: "no" }],
      [{ decision: "edit", params: { appointmentId: 9 } } as HumanDecision, { decision: "edited", params: { appointmentId: 9 }, proposed: { appointmentId: 7 } }],
    ] as const) {
      const id = threads.fresh();
      const first = program([cancel()]);
      await runTurn(first.agent, id, "Cancelá el turno 7");
      await first.close();

      const second = program([new AIMessage("ok")]);
      await resumeTurn(second.agent, id, decision);
      expect(second.actions.executed).toHaveLength(1);
      expect(second.actions.executed[0]).toMatchObject(expected);
      await second.close();
    }
  });

  it("una decisión mal formada devuelve la misma propuesta con el motivo y no ejecuta nada", async () => {
    const id = threads.fresh();
    const p = program([cancel(), new AIMessage("ok")]);
    await runTurn(p.agent, id, "Cancelá el turno 7");
    const again = await resumeTurn(p.agent, id, { decision: "approve", params: { appointmentId: 1 } } as never);
    expect(again.awaiting?.error).toMatch(/Decisión inválida/);
    expect(again.awaiting?.action.id).toBe(`${id}:toolu_1`);
    expect(p.actions.execute).not.toHaveBeenCalled();
    expect((await getStatus(p.graph, id)).awaiting?.error).toMatch(/Decisión inválida/);
    await p.close();
  });

  it("si la ejecución falla por una caída, el hilo queda a medias (no esperando) y continuar la termina sin repetir la propuesta", async () => {
    const id = threads.fresh();
    let attempts = 0;
    const actions = fakeActions();
    const original = actions.execute.getMockImplementation()!;
    actions.execute.mockImplementation(async (input, now) => {
      if (attempts++ === 0) throw new Error("conexión caída");
      return original(input, now);
    });

    const p = program([cancel(), new AIMessage("Listo.")], actions);
    await runTurn(p.agent, id, "Cancelá el turno 7");
    await expect(resumeTurn(p.agent, id, approve)).rejects.toThrow(/conexión caída/);

    const status = await getStatus(p.graph, id);
    expect(status.awaiting).toBeUndefined();
    expect(status).toMatchObject({ pending: true, next: ["execute_action"] });
    await expect(runTurn(p.agent, id, "otra cosa")).rejects.toBeInstanceOf(ThreadPendingError);

    // No hace falta decidir de nuevo: la decisión ya está guardada. Se continúa y se ejecuta.
    const done = await continueTurn(p.agent, id);
    expect(done.reply).toBe("Listo.");
    expect(actions.executed).toHaveLength(1);
    expect(actions.executed[0]).toMatchObject({ actionId: `${id}:toolu_1`, decision: "approved" });
    await p.close();
  });
});
