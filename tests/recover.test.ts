import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { detectLoop, MAX_TOOL_ROUNDS, recoverMessage } from "../src/graph/nodes/recover.js";
import type { Plan } from "../src/graph/plan.js";
import { streamRunTurn } from "../src/graph/run-turn.js";
import { getStatus } from "../src/graph/threads.js";
import type { UiEvent } from "../src/web/events.js";
import { fakeActions } from "./helpers/actions.js";
import { buildTestGraph } from "./helpers/graph.js";
import { scriptedModel, StreamingChatModel, toolCall } from "./helpers/models.js";

// Fase 10 (T4, R5 a R7, CA2): el tope de rondas, las llamadas repetidas y el nodo recover.

const round = (id: string, args: Record<string, unknown> = { query: id }, name = "getStockLevels") => toolCall(id, name, args);
const stock = tool(async ({ query }) => JSON.stringify({ query, stock: 3 }), {
  name: "getStockLevels",
  description: "stock",
  schema: z.object({ query: z.string().optional() }),
});
async function all(events: AsyncIterable<UiEvent>) {
  const out: UiEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("detectLoop", () => {
  const msgs = (...rounds: AIMessage[]) => [new HumanMessage("x"), ...rounds.flatMap((r, i) => (i < rounds.length - 1 ? [r, new ToolMessage({ content: "{}", tool_call_id: r.tool_calls![0]!.id! })] : [r]))];

  it("hasta 4 rondas distintas no es loop; la quinta sí", () => {
    expect(MAX_TOOL_ROUNDS).toBe(4);
    expect(detectLoop({ messages: msgs(round("1"), round("2"), round("3"), round("4")) })).toBeUndefined();
    expect(detectLoop({ messages: msgs(round("1"), round("2"), round("3"), round("4"), round("5")) })).toEqual({ kind: "rounds", rounds: 4 });
  });

  it("repetir la misma llamada (mismo nombre y argumentos, aunque cambie el orden de las claves) es loop", () => {
    expect(detectLoop({ messages: msgs(round("1", { a: 1, b: 2 }), round("2", { b: 2, a: 1 })) })).toEqual({ kind: "repeat", call: "getStockLevels" });
    expect(detectLoop({ messages: msgs(round("1", { a: 1 }), round("2", { a: 2 })) })).toBeUndefined();
  });

  it("solo cuentan las rondas de la tarea en curso (desde startedAt)", () => {
    const messages = msgs(round("1", { q: "x" }), round("2", { q: "y" }), round("3", { q: "x" }));
    const plan: Plan = { tasks: [{ id: "1", intent: "query", request: "otra", status: "done", startedAt: 0 }, { id: "2", intent: "query", request: "esta", status: "running", startedAt: 4 }] };
    // Sin plan, la tercera repite la primera; con la tarea empezando en el mensaje 4, la primera no es de esta tarea.
    expect(detectLoop({ messages })).toEqual({ kind: "repeat", call: "getStockLevels" });
    expect(detectLoop({ messages, plan })).toBeUndefined();
  });

  it("el mensaje de cierre dice qué consultó, por qué cortó y no da datos", () => {
    const text = recoverMessage({ kind: "rounds", rounds: 4 }, ["getStockLevels", "getStockLevels", "listAppointments"], "query");
    expect(text).toMatch(/^No pude terminar la consulta: hice 4 rondas/);
    expect(text).toMatch(/stock de productos, agenda de turnos/);
    expect(text).toMatch(/No te doy un dato que no pude confirmar/);
    expect(recoverMessage({ kind: "repeat", call: "findClient" }, [], "action")).toMatch(/^No pude preparar la acción: estaba repitiendo la misma consulta \(búsqueda de clientes\)/);
  });
});

describe("recover en el grafo (CA2)", () => {
  it("consultas: 5 rondas → recover; el turno termina listo (no a medias) y sin GraphRecursionError", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = new StreamingChatModel([1, 2, 3, 4, 5, 6].map((i) => round(String(i))));
    const graph = buildTestGraph({ model, tools: [stock], checkpointer: new MemorySaver() });
    const events = await all(streamRunTurn({ graph }, "hilo-loop", "¿stock?"));
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("no terminó");
    expect(done.result.reply).toMatch(/^No pude terminar la consulta: hice 4 rondas/);
    expect(model.calls).toBe(5);
    // La quinta ronda pedida no se ejecutó: se ve como «no se ejecutó», no como una falla de la base.
    expect(events.filter((e) => e.type === "tool_end" && e.skipped)).toHaveLength(1);
    expect(done.result.summary.failedTools).toEqual([]);
    const status = await getStatus(graph, "hilo-loop");
    expect(status.pending).toBe(false);
    // El hilo acepta otro mensaje: cada pedido de herramienta tiene su respuesta.
    const calls = status.messages.flatMap((m) => (AIMessage.isInstance(m) ? (m.tool_calls ?? []).map((c) => c.id) : []));
    const answered = new Set(status.messages.filter((m) => ToolMessage.isInstance(m)).map((m) => (m as ToolMessage).tool_call_id));
    expect(calls.every((id) => answered.has(id!))).toBe(true);
  });

  it("acciones: una consulta repetida corta en recover, sin proponer nada", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const actions = fakeActions();
    const { model, calls } = scriptedModel((n) => toolCall(`c${n}`, "findClient", { name: "Julián" }));
    const findClient = tool(async () => "[]", { name: "findClient", description: "c", schema: z.object({ name: z.string() }) });
    const graph = buildTestGraph({ model, tools: [findClient], intent: "action", actions: actions.runner, checkpointer: new MemorySaver() });
    const result = await graph.invoke({ messages: [new HumanMessage("agendá a Julián")] }, { configurable: { thread_id: "hilo-acc" } });
    expect(result.messages.at(-1)!.text).toMatch(/^No pude preparar la acción: estaba repitiendo la misma consulta/);
    expect(calls).toHaveLength(2);
    expect(actions.prepare).not.toHaveBeenCalled();
    expect((await getStatus(graph, "hilo-acc")).pending).toBe(false);
  });

  it("acciones: una propuesta inválida repetida tal cual también es un loop", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const actions = fakeActions();
    const bad = { sku: "INVALIDO", delta: 5, reason: "x" };
    const { model } = scriptedModel((n) => toolCall(`a${n}`, "adjustStock", bad));
    const graph = buildTestGraph({ model, tools: [], intent: "action", actions: actions.runner, checkpointer: new MemorySaver() });
    const result = await graph.invoke({ messages: [new HumanMessage("sumá 5")] }, { configurable: { thread_id: "hilo-acc-2" } });
    expect(result.messages.at(-1)!.text).toMatch(/^No pude preparar la acción/);
    expect(actions.prepare).toHaveBeenCalledTimes(1); // la primera se intentó preparar; la repetida, no
    expect(actions.executed).toEqual([]);
  });

  it("un pedido normal (dos rondas distintas) no se ve afectado", async () => {
    const { model } = scriptedModel([round("1", { query: "cera" }), round("2", { query: "gel" }), new AIMessage("Cera 3, gel 3.")]);
    const graph = buildTestGraph({ model, tools: [stock] });
    const result = await graph.invoke({ messages: [new HumanMessage("¿cera y gel?")] });
    expect(result.messages.at(-1)!.text).toBe("Cera 3, gel 3.");
  });
});
