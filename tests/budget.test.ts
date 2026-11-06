import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import { resumeTurn, streamRunTurn, type TurnLimits } from "../src/graph/run-turn.js";
import { getStatus } from "../src/graph/threads.js";
import { MemoryTraceStore } from "../src/observability/store.js";
import type { Trace } from "../src/observability/trace-recorder.js";
import { BudgetExceededError, checkBudget, spentToday, startOfTodayAR } from "../src/ops/budget.js";
import type { UiEvent } from "../src/web/events.js";
import { makeHandlers } from "../src/web/handlers.js";
import { fakeActions } from "./helpers/actions.js";
import { buildTestGraph } from "./helpers/graph.js";
import { scriptedModel, toolCall } from "./helpers/models.js";

// Fase 12 (T5, CA3): el tope de gasto diario, a partir de las trazas.

const trace = (startedAt: string, costUsd: number | null, over: Partial<Trace> = {}): Trace => ({
  id: crypto.randomUUID(),
  threadId: "h",
  kind: "new",
  startedAt,
  durationMs: 1,
  status: "ok",
  route: [],
  calls: 1,
  inputTokens: 1,
  outputTokens: 1,
  costUsd,
  retries: 0,
  spans: [],
  ...over,
});

async function all(events: AsyncIterable<UiEvent>) {
  const out: UiEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("lo que se gastó hoy", () => {
  it("el día empieza a la medianoche de Argentina", () => {
    expect(startOfTodayAR(new Date("2026-11-06T02:30:00Z")).toISOString()).toBe("2026-11-05T03:00:00.000Z"); // 23:30 del 5 en Argentina
    expect(startOfTodayAR(new Date("2026-11-06T03:30:00Z")).toISOString()).toBe("2026-11-06T03:00:00.000Z"); // 00:30 del 6
  });

  it("suma los turnos de hoy, sin los de ayer ni los de las evaluaciones", async () => {
    const store = new MemoryTraceStore();
    await store.save(trace("2026-11-06T12:00:00Z", 0.4));
    await store.save(trace("2026-11-06T15:00:00Z", 0.25));
    await store.save(trace("2026-11-06T02:00:00Z", 5)); // el 5 a la noche, en Argentina
    await store.save(trace("2026-11-06T13:00:00Z", 3, { evalRunId: "r", evalCaseId: "Q1" }));
    expect(await spentToday(store, new Date("2026-11-06T20:00:00Z"))).toBeCloseTo(0.65);
  });

  it("checkBudget: sin tope o con 0 no limita; al alcanzarlo, lanza con lo gastado", async () => {
    await expect(checkBudget(undefined, async () => 100)).resolves.toBeUndefined();
    await expect(checkBudget(0, async () => 100)).resolves.toBeUndefined();
    await expect(checkBudget(1, async () => 0.99)).resolves.toBeUndefined();
    const error = await checkBudget(1, async () => 1.02).catch((e) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error.message).toMatch(/US\$ 1,02 de US\$ 1,00/);
  });
});

describe("un turno con el tope alcanzado", () => {
  const over: TurnLimits = { dailyBudgetUsd: 1, spentToday: async () => 1.5 };

  it("no llama al modelo, no guarda el mensaje ni deja traza", async () => {
    const { model, calls } = scriptedModel([new AIMessage("hola")]);
    const traces = new MemoryTraceStore();
    const graph = buildTestGraph({ model, tools: [], intent: "chat", checkpointer: new MemorySaver() });
    await expect(all(streamRunTurn({ graph, traces, limits: over }, "h", "hola"))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toHaveLength(0);
    expect((await getStatus(graph, "h")).exists).toBe(false);
    expect(traces.traces).toEqual([]);
  });

  it("una tarjeta pendiente sigue pendiente: decidir también espera al día siguiente", async () => {
    const actions = fakeActions();
    const model = scriptedModel([toolCall("a1", "adjustStock", { sku: "CER-001", delta: 5, reason: "pedido" }), new AIMessage("Listo.")]);
    const graph = buildTestGraph({ model: model.model, tools: [], intent: "action", actions: actions.runner, checkpointer: new MemorySaver() });
    await all(streamRunTurn({ graph }, "h", "sumá 5"));
    await expect(resumeTurn({ graph, limits: over }, "h", { decision: "approve" })).rejects.toBeInstanceOf(BudgetExceededError);
    expect((await getStatus(graph, "h")).awaiting).toBeDefined();
    expect(actions.executed).toEqual([]);
  });

  it("en la web, el pedido no empieza: 429 con el aviso, y el hilo queda como estaba", async () => {
    const { model, calls } = scriptedModel([new AIMessage("hola")]);
    const graph = buildTestGraph({ model, tools: [], intent: "chat", checkpointer: new MemorySaver() });
    const handlers = makeHandlers({ graph, listThreads: async () => [], limits: over, log: vi.fn() });
    const origin = "http://127.0.0.1:3000";
    const response = await handlers.postMessage(
      new Request(`${origin}/api/threads/h/messages`, { method: "POST", headers: { "content-type": "application/json", origin, host: "127.0.0.1:3000" }, body: JSON.stringify({ text: "hola" }) }),
      "h",
    );
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: string }).error).toMatch(/tope de gasto de hoy/);
    expect(calls).toHaveLength(0);
    expect((await getStatus(graph, "h")).exists).toBe(false);
  });

  it("dentro del tope, el turno anda como siempre", async () => {
    const { model } = scriptedModel([new AIMessage("hola")]);
    const graph = buildTestGraph({ model, tools: [], intent: "chat", checkpointer: new MemorySaver() });
    const result = (await all(streamRunTurn({ graph, limits: { dailyBudgetUsd: 1, spentToday: async () => 0.3 } }, "h", "hola"))).at(-1);
    expect(result).toMatchObject({ type: "done", result: { reply: "hola" } });
  });
});
