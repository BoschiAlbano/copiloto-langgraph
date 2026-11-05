import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Command, MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TraceRecorder, type Trace, type TraceSpan } from "../src/observability/trace-recorder.js";
import { fakeActions } from "./helpers/actions.js";
import { buildTestGraph } from "./helpers/graph.js";
import { StreamingChatModel, toolCall } from "./helpers/models.js";

// Fase 11 (T2, CA1): el árbol de una traza, a partir de los callbacks de LangGraph, con modelos falsos.

type Graph = ReturnType<typeof buildTestGraph>;

/** Corre el grafo con el recorder, como lo hará `streamInvoke` (los mismos modos de stream y subgrafos). */
async function traced(graph: Graph, input: unknown, threadId = "h") {
  const recorder = new TraceRecorder();
  let error: unknown;
  try {
    const stream = await graph.stream(input as never, {
      configurable: { thread_id: threadId },
      callbacks: [recorder],
      streamMode: ["values", "updates", "messages", "custom"],
      subgraphs: true,
    });
    for await (const _ of stream) {
      /* consumir */
    }
  } catch (e) {
    error = e;
  }
  return { recorder, error };
}

const childrenOf = (trace: Trace, parent?: TraceSpan) => trace.spans.filter((s) => s.parentId === parent?.id);
const named = (trace: Trace, name: string) => trace.spans.filter((s) => s.name === name);
/** El árbol como texto, para comparar la forma: «nombre(hijos…)». */
function shape(trace: Trace, span = trace.spans.find((s) => s.kind === "turn")!): string {
  const kids = childrenOf(trace, span);
  const label = span.kind === "llm" ? "llm" : span.name;
  return kids.length ? `${label}(${kids.map((k) => shape(trace, k)).join(" ")})` : label;
}
const meta = { threadId: "h", kind: "new" as const, status: "ok" as const, route: ["query"] };

describe("TraceRecorder (CA1)", () => {
  it("una consulta con herramienta: los nodos del subgrafo cuelgan de él; el modelo trae tokens y la herramienta, argumentos", async () => {
    const getStock = tool(async () => JSON.stringify({ items: [{ name: "Cera mate", stock: 31 }] }), {
      name: "getStockLevels",
      description: "stock",
      schema: z.object({ query: z.string().optional() }),
    });
    const graph = buildTestGraph({
      model: new StreamingChatModel([toolCall("c1", "getStockLevels", { query: "cera" }), new AIMessage("Quedan 31.")]),
      tools: [getStock],
      intent: "query",
      checkpointer: new MemorySaver(),
    });
    const { recorder, error } = await traced(graph, { messages: [new HumanMessage("¿stock de cera?")] });
    expect(error).toBeUndefined();
    const trace = recorder.finish({ ...meta, input: "¿stock de cera?" });

    expect(shape(trace)).toBe("turno(load_memory router supervisor query_graph(agent(llm) tools(getStockLevels) agent(llm)) supervisor)");
    // Ninguna pieza interna de LangChain o LangGraph se cuela.
    expect(trace.spans.map((s) => s.name)).not.toContain("ChannelWrite");
    expect(trace.spans.map((s) => s.name)).not.toContain("LangGraph");

    const [tool1] = named(trace, "getStockLevels");
    expect(tool1).toMatchObject({ kind: "tool", status: "ok", args: { query: "cera" } });
    expect(tool1!.result).toContain("Cera mate");
    const llm = trace.spans.filter((s) => s.kind === "llm");
    expect(llm.map((s) => [s.model, s.inputTokens, s.outputTokens])).toEqual([
      ["claude-haiku-5-5", 100, 10],
      ["claude-haiku-5-5", 100, 10],
    ]);
    expect(trace).toMatchObject({ calls: 2, inputTokens: 200, outputTokens: 20, status: "ok", input: "¿stock de cera?", route: ["query"] });
    expect(trace.costUsd).toBeGreaterThan(0);
    // Los tiempos son relativos al inicio del turno y cada paso está adentro de su padre.
    for (const s of trace.spans) {
      const parent = trace.spans.find((p) => p.id === s.parentId);
      expect(s.start).toBeGreaterThanOrEqual(0);
      if (parent) expect(s.start).toBeGreaterThanOrEqual(parent.start);
    }
  });

  it("un reporte: las tres secciones y la «Lectura» cuelgan de report_graph", async () => {
    const reportPlan = { async invoke() { return { parsed: { reason: "semana", kind: "this_week" } }; } };
    const graph = buildTestGraph({
      model: new StreamingChatModel([new AIMessage("Lectura de prueba.")]),
      tools: [],
      intent: "report",
      reportPlan: reportPlan as never,
      reportSections: async (section, reportId) =>
        ({
          reportId,
          section,
          status: "ok",
          data:
            section === "sales"
              ? { salesCount: 0, totalRevenue: 0, averageTicket: 0, byPaymentMethod: [], byItemType: { products: { units: 0, revenue: 0 }, services: { units: 0, revenue: 0 } } }
              : section === "appointments"
                ? { total: 0, activeCount: 0, countByStatus: {} }
                : { total: 15, lowCount: 0, low: [] },
        }) as never,
      checkpointer: new MemorySaver(),
    });
    const { recorder } = await traced(graph, { messages: [new HumanMessage("resumen de la semana")] });
    const trace = recorder.finish({ ...meta, route: ["report"] });
    const report = named(trace, "report_graph")[0]!;
    expect(childrenOf(trace, report).map((s) => s.name).sort()).toEqual(["compose_report", "plan_report", "report_appointments", "report_sales", "report_stock"]);
    expect(childrenOf(trace, named(trace, "compose_report")[0]).map((s) => s.kind)).toEqual(["llm"]);
  });

  it("una acción: la pausa queda como interrumpida (no como error); decidir es otro turno, con su propia traza", async () => {
    const actions = fakeActions();
    const graph = buildTestGraph({
      model: new StreamingChatModel([toolCall("a1", "adjustStock", { sku: "CER-001", delta: 5, reason: "pedido" }), new AIMessage("Listo.")]),
      tools: [],
      intent: "action",
      actions: actions.runner,
      checkpointer: new MemorySaver(),
    });
    const first = await traced(graph, { messages: [new HumanMessage("sumá 5")] });
    const paused = first.recorder.finish({ ...meta, status: "awaiting", route: ["action"] });
    expect(paused.spans.find((s) => s.name === "await_approval")).toMatchObject({ status: "interrupted" });
    expect(paused.spans.filter((s) => s.status === "error")).toEqual([]);
    expect(paused.spans.find((s) => s.kind === "turn")).toMatchObject({ status: "interrupted" });

    const second = await traced(graph, new Command({ resume: { decision: "approve" } }));
    const resumed = second.recorder.finish({ ...meta, kind: "resume", route: ["action"] });
    expect(resumed.id).not.toBe(paused.id);
    expect(resumed.spans.map((s) => s.name)).toContain("execute_action");
    expect(actions.executed).toHaveLength(1);
  });

  it("un turno que falla: el nodo queda con el error y la traza también", async () => {
    const failing = { async invoke() { throw new Error("connect ECONNREFUSED 127.0.0.1:5432"); } };
    const graph = buildTestGraph({ model: failing as never, tools: [], intent: "chat", checkpointer: new MemorySaver() });
    const { recorder, error } = await traced(graph, { messages: [new HumanMessage("hola")] });
    expect(error).toBeDefined();
    const trace = recorder.finish({ ...meta, status: "error", error: "No se pudo completar el pedido", route: ["chat"] });
    expect(named(trace, "chat")[0]).toMatchObject({ status: "error" });
    expect(named(trace, "chat")[0]!.error).toMatch(/ECONNREFUSED/);
    expect(trace).toMatchObject({ status: "error", error: "No se pudo completar el pedido" });
    expect(trace.spans.find((s) => s.kind === "turn")).toMatchObject({ status: "error" });
  });

  it("los reintentos se suman a la herramienta que está corriendo con ese nombre (y a la sección, por su nodo)", () => {
    let now = 1000;
    const recorder = new TraceRecorder(() => now);
    recorder.handleChainStart({} as never, {}, "root", undefined, [], {}, undefined, "LangGraph");
    recorder.handleToolStart({} as never, '{"date":"2026-11-06"}', "t1", "root", [], {}, "listAppointments");
    recorder.noteRetry("listAppointments");
    recorder.noteRetry("listAppointments");
    now = 1600;
    recorder.handleToolEnd("{}", "t1");
    recorder.handleChainStart({} as never, {}, "s1", "root", [], { langgraph_node: "report_stock" }, undefined, "report_stock");
    recorder.noteRetry("section:stock");
    recorder.noteRetry("otra-cosa"); // ningún paso con ese nombre: se ignora
    const trace = recorder.finish(meta);
    expect(trace.spans.find((s) => s.name === "listAppointments")).toMatchObject({ retries: 2, duration: 600, args: { date: "2026-11-06" } });
    expect(trace.spans.find((s) => s.name === "report_stock")).toMatchObject({ retries: 1, status: "running" });
    expect(trace.retries).toBe(3);
  });

  it("un resultado largo se guarda recortado", () => {
    const recorder = new TraceRecorder();
    recorder.handleChainStart({} as never, {}, "root", undefined, [], {}, undefined, "LangGraph");
    recorder.handleToolStart({} as never, "{}", "t1", "root", [], {}, "findClient");
    recorder.handleToolEnd("x".repeat(5000), "t1");
    const result = recorder.finish(meta).spans.find((s) => s.kind === "tool")!.result!;
    expect(result.length).toBe(2001);
    expect(result.endsWith("…")).toBe(true);
  });
});
