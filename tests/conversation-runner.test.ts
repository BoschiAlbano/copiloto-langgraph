import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ConversationCase } from "../evals/conversation-cases.js";
import { AUTO_REJECT, runCase } from "../evals/conversation.js";
import { getStatus } from "../src/graph/threads.js";
import { listMemories } from "../src/memory/store.js";
import { MemoryTraceStore } from "../src/observability/store.js";
import { fakeActions } from "./helpers/actions.js";
import { buildTestGraph } from "./helpers/graph.js";
import { StreamingChatModel, toolCall } from "./helpers/models.js";

// Fase 11 (T5): el corredor de un caso, con modelos falsos. Sin base: el SQL es falso.

const NAMESPACE = ["test", "eval-runner"];
const getStock = tool(async () => JSON.stringify({ items: [{ name: "Cera mate", stock: 31 }] }), { name: "getStockLevels", description: "stock", schema: z.object({ query: z.string().optional() }) });
const sql = async (q: string) => (q === "STOCK" ? [31] : []);

function setup(model: StreamingChatModel, intent: "query" | "action" = "query", actions = fakeActions()) {
  const checkpointer = new MemorySaver();
  const store = new InMemoryStore();
  const graph = buildTestGraph({ model, tools: [getStock], intent, actions: actions.runner, checkpointer, store, memoryNamespace: NAMESPACE });
  const traces = new MemoryTraceStore();
  const deps = {
    agent: { graph, checkpointer },
    traces: (caseId: string) => ({ save: (t: Parameters<MemoryTraceStore["save"]>[0]) => traces.save({ ...t, evalRunId: "11111111-1111-4111-8111-111111111111", evalCaseId: caseId }) }),
    memory: { store, namespace: NAMESPACE },
    sql,
    runTag: "abc123",
  };
  return { deps, traces, actions, graph, store };
}

const stockCase: ConversationCase = {
  id: "Q2",
  category: "consultas",
  turns: ["¿Cuánto stock queda de cera mate?"],
  checks: [{ kind: "usesTools", tools: ["getStockLevels"] }, { kind: "replyHasSqlNumbers", sql: "STOCK", what: "el stock" }],
};

describe("runCase", () => {
  it("una consulta que contesta bien: pasa, con tokens, costo y la traza del turno marcada con su caso", async () => {
    const { deps, traces, graph } = setup(new StreamingChatModel([toolCall("c1", "getStockLevels", { query: "cera mate" }), new AIMessage("Quedan 31 unidades.")]));
    const run = await runCase(stockCase, 1, deps);
    expect(run).toMatchObject({ caseId: "Q2", category: "consultas", runNo: 1, passed: true, reply: "Quedan 31 unidades.", inputTokens: 200, outputTokens: 20 });
    expect(run.results.every((r) => r.ok)).toBe(true);
    expect(traces.traces).toHaveLength(1);
    expect(traces.traces[0]).toMatchObject({ id: run.traceId, evalCaseId: "Q2", threadId: "eval-abc123-q2-1" });
    // El hilo se borra; la traza queda.
    expect((await getStatus(graph, "eval-abc123-q2-1")).exists).toBe(false);
  });

  it("una respuesta equivocada no pasa, y dice qué regla falló", async () => {
    const { deps } = setup(new StreamingChatModel([toolCall("c1", "getStockLevels"), new AIMessage("Quedan 13 unidades.")]));
    const run = await runCase(stockCase, 1, deps);
    expect(run.passed).toBe(false);
    expect(run.results.find((r) => !r.ok)!.detail).toBe("la respuesta no tiene el stock: falta 31");
  });

  it("una acción: la tarjeta se observa y se rechaza sola; no se ejecuta nada", async () => {
    const actions = fakeActions();
    const { deps } = setup(new StreamingChatModel([toolCall("a1", "adjustStock", { sku: "ACC-001", delta: -3, reason: "venta" }), new AIMessage("No lo hice.")]), "action", actions);
    const run = await runCase(
      { id: "A3", category: "acciones", turns: ["Descontá tres peines del stock."], checks: [{ kind: "proposes", tool: "adjustStock", params: { sku: "ACC-001", delta: -3 } }] },
      1,
      deps,
    );
    expect(run.passed).toBe(true);
    expect(actions.executed.map((e) => e.decision)).toEqual(["rejected"]);
    expect(actions.executed[0]).toMatchObject({ comment: AUTO_REJECT });
  });

  it("las memorias del caso se siembran antes y se borran después", async () => {
    const { deps, store } = setup(new StreamingChatModel([new AIMessage("Los lunes no se agenda.")]));
    const run = await runCase(
      {
        id: "M3",
        category: "memoria",
        memories: [{ kind: "rule", text: "Los lunes no se agendan turnos." }],
        turns: ["Agendá un corte el lunes."],
        checks: [{ kind: "memoryUnchanged" }, { kind: "replyMatches", pattern: /lunes/i, what: "la regla" }],
      },
      1,
      deps,
    );
    expect(run.passed).toBe(true);
    expect(await listMemories({ store, namespace: NAMESPACE })).toEqual([]);
  });

  it("un error del sistema no corta la corrida: el caso no pasa y dice por qué", async () => {
    const broken = { async invoke() { throw new Error("connect ECONNREFUSED"); } };
    const checkpointer = new MemorySaver();
    const store = new InMemoryStore();
    const graph = buildTestGraph({ model: broken as never, tools: [], intent: "chat", checkpointer, store, memoryNamespace: NAMESPACE });
    const run = await runCase({ id: "H2", category: "charla y aclaración", turns: ["Gracias."], checks: [{ kind: "noTools" }] }, 1, {
      agent: { graph, checkpointer },
      memory: { store, namespace: NAMESPACE },
      sql,
      runTag: "abc123",
    });
    expect(run).toMatchObject({ passed: false, results: [] });
    expect(run.error).toMatch(/ECONNREFUSED/);
  });
});
