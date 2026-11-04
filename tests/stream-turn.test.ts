import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { SectionRunner } from "../src/graph/nodes/report.js";
import { continueTurn, runTurn, streamResumeTurn, streamRunTurn } from "../src/graph/run-turn.js";
import { getStatus } from "../src/graph/threads.js";
import { toUiEvents, uiEventSchema, type UiEvent } from "../src/web/events.js";
import { fakeActions } from "./helpers/actions.js";
import { buildTestGraph } from "./helpers/graph.js";
import { StreamingChatModel, toolCall } from "./helpers/models.js";

// Fase 9 (T2): un turno en vivo. CA1 (tokens), CA2 (herramientas mientras ocurren), CA5 (un solo camino),
// CA6 (qué se transmite) y CA8 (corte) con modelos falsos que SÍ transmiten tokens.

const stock = tool(async () => JSON.stringify({ items: [{ name: "Cera mate", stock: 31 }] }), {
  name: "getStockLevels",
  description: "Stock de productos",
  schema: z.strictObject({}),
});

const ask = (text: string) => [new HumanMessage(text)];
async function all(events: AsyncIterable<UiEvent>): Promise<UiEvent[]> {
  const out: UiEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
const indexOf = (events: UiEvent[], test: (e: UiEvent) => boolean) => events.findIndex(test);
const doneOf = (events: UiEvent[]) => {
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error("el último evento no es done");
  return done.result;
};

/** Un modelo con salida estructurada que, además, "habla" por el canal de tokens (como lo haría uno real). */
function chattyStructured(parsed: unknown, chatter = "pensando la respuesta estructurada") {
  const inner = new StreamingChatModel(Array.from({ length: 5 }, () => new AIMessage(chatter)));
  return { model: { async invoke(messages: BaseMessage[]) { await inner.invoke(messages); return { parsed }; } }, inner };
}

describe("streamRunTurn: una consulta con herramienta (CA1, CA2)", () => {
  const STEP = "Voy a mirar el stock. ";
  const REPLY = "Quedan 31 unidades de cera mate en el depósito.";
  const setup = () =>
    buildTestGraph({
      model: new StreamingChatModel([new AIMessage({ content: STEP, tool_calls: [{ id: "c1", name: "getStockLevels", args: {}, type: "tool_call" }] }), new AIMessage(REPLY)]),
      tools: [stock],
      checkpointer: new MemorySaver(),
    });

  it("los eventos llegan en orden: ruta, agente, herramienta pedida y terminada, tokens de la respuesta, mensaje, fin", async () => {
    const events = await all(streamRunTurn({ graph: setup() }, "hilo-vivo", "¿Cuánto stock hay de cera mate?"));
    for (const event of events) expect(() => uiEventSchema.parse(event)).not.toThrow();

    const route = indexOf(events, (e) => e.type === "route");
    const start = indexOf(events, (e) => e.type === "agent" && e.status === "start");
    const toolStart = indexOf(events, (e) => e.type === "tool_start");
    const toolEnd = indexOf(events, (e) => e.type === "tool_end");
    const reply = events.find((e) => e.type === "message" && e.kind === "reply");
    if (reply?.type !== "message") throw new Error("falta la respuesta");
    const replyTokens = events.filter((e) => e.type === "token" && e.messageId === reply.id);
    const firstReplyToken = events.indexOf(replyTokens[0]!);
    const end = indexOf(events, (e) => e.type === "agent" && e.status === "end");

    expect(route).toBeGreaterThanOrEqual(0);
    expect(route).toBeLessThan(start);
    expect(start).toBeLessThan(toolStart);
    expect(toolStart).toBeLessThan(toolEnd);
    expect(toolEnd).toBeLessThan(firstReplyToken); // la herramienta se ve ANTES que el texto de la respuesta
    expect(events.indexOf(replyTokens.at(-1)!)).toBeLessThan(events.indexOf(reply));
    expect(events.indexOf(reply)).toBeLessThan(end);
    expect(events.at(-1)?.type).toBe("done");

    expect(events[toolStart]).toMatchObject({ type: "tool_start", id: "c1", agent: "query_graph", name: "getStockLevels", args: {} });
    expect(events[toolEnd]).toEqual({ type: "tool_end", id: "c1", name: "getStockLevels", ok: true });
    // Progresivo: varios tokens, que juntos son el mensaje final (el que queda guardado en el hilo).
    expect(replyTokens.length).toBeGreaterThan(5);
    expect(replyTokens.map((e) => (e.type === "token" ? e.text : "")).join("")).toBe(REPLY);
    expect(reply).toMatchObject({ author: "query_graph", text: REPLY });
  });

  it("el texto que acompaña a una herramienta es un paso, no la respuesta (el mismo criterio que turnReply)", async () => {
    const events = await all(streamRunTurn({ graph: setup() }, "hilo-vivo", "¿Cuánto stock hay de cera mate?"));
    expect(events.filter((e) => e.type === "message")).toEqual([
      expect.objectContaining({ kind: "step", author: "query_graph", text: STEP.trim() }),
      expect.objectContaining({ kind: "reply", author: "query_graph", text: REPLY }),
    ]);
    const result = doneOf(events);
    expect(result.reply).toBe(REPLY);
    expect(result.route.tasks?.map((t) => t.intent)).toEqual(["query"]);
    expect(result.summary.toolCalls).toEqual([{ name: "getStockLevels", args: {} }]);
    expect(result.agents.map((a) => a.agent)).toEqual(["query_graph"]);
  });

  it("CA5: runTurn devuelve lo mismo que el evento done del camino en vivo", async () => {
    const live = doneOf(await all(streamRunTurn({ graph: setup() }, "hilo-a", "¿Cuánto stock hay de cera mate?")));
    const plain = await runTurn({ graph: setup() }, "hilo-b", "¿Cuánto stock hay de cera mate?");
    expect(plain).toEqual(live);
  });
});

describe("qué se transmite (CA6)", () => {
  it("los tokens del router y de la memoria (salida estructurada) no llegan; la respuesta de la memoria llega entera", async () => {
    const router = chattyStructured({ reason: "pide recordar", tasks: [{ intent: "memory", request: "acordate de que los lunes no se agendan turnos" }] });
    const memory = chattyStructured({ operation: "save", kind: "rule", text: "Los lunes no se agendan turnos." });
    const graph = buildTestGraph({
      model: new StreamingChatModel([]),
      tools: [],
      router: router.model,
      memoryModel: memory.model,
      store: new InMemoryStore(),
      checkpointer: new MemorySaver(),
    });
    const events = await all(streamRunTurn({ graph }, "hilo-memoria", "Acordate de que los lunes no se agendan turnos."));

    // Los dos modelos sí hablaron por el canal de tokens…
    expect(router.inner.calls).toBe(1);
    expect(memory.inner.calls).toBe(1);
    // …pero nada de eso llega a la interfaz.
    expect(events.filter((e) => e.type === "token")).toEqual([]);
    expect(events.filter((e) => e.type === "message")).toEqual([
      expect.objectContaining({ author: "memory", kind: "reply", text: expect.stringMatching(/^Anoté esta regla/) }),
    ]);
    expect(doneOf(events).memoryCount).toBe(1);
  });

  it("la charla se transmite token por token", async () => {
    const graph = buildTestGraph({ model: new StreamingChatModel([new AIMessage("¡Hola! ¿En qué te ayudo hoy?")]), tools: [], intent: "chat", checkpointer: new MemorySaver() });
    const events = await all(streamRunTurn({ graph }, "hilo-charla", "hola"));
    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.length).toBeGreaterThan(3);
    expect(tokens.every((e) => e.type === "token" && e.agent === "chat")).toBe(true);
    expect(events.filter((e) => e.type === "message")).toEqual([expect.objectContaining({ author: "chat", kind: "reply", text: "¡Hola! ¿En qué te ayudo hoy?" })]);
  });

  it("el reporte: las secciones llegan a medida que terminan y el texto llega entero (la «Lectura» no se transmite)", async () => {
    const sections: SectionRunner = async (section, reportId) => ({ reportId, section, status: "ok", data: { total: 0, activeCount: 0, countByStatus: {}, lowCount: 0, low: [], salesCount: 0, totalRevenue: 0, averageTicket: 0, byPaymentMethod: [], byItemType: { products: { units: 0, revenue: 0 }, services: { units: 0, revenue: 0 } } } });
    const reading = new StreamingChatModel([new AIMessage("• Una semana tranquila.")]);
    const graph = buildTestGraph({
      model: reading,
      tools: [],
      intent: "report",
      reportPlan: { async invoke() { return { parsed: { reason: "la semana", kind: "this_week" } }; } },
      reportSections: sections,
      now: () => new Date("2026-10-28T15:00:00Z"),
      checkpointer: new MemorySaver(),
    });
    const events = await all(streamRunTurn({ graph }, "hilo-reporte", "Armame el resumen de la semana."));
    const sectionEvents = events.filter((e) => e.type === "report_section");
    expect(sectionEvents.map((e) => e.type === "report_section" && e.section).sort()).toEqual(["appointments", "sales", "stock"]);
    expect(reading.calls).toBe(1); // el modelo escribió la «Lectura»…
    expect(events.filter((e) => e.type === "token")).toEqual([]); // …pero no se transmitió
    const report = events.find((e) => e.type === "message");
    expect(report).toMatchObject({ author: "report_graph", kind: "reply" });
    expect(events.indexOf(sectionEvents.at(-1)!)).toBeLessThan(events.indexOf(report!));
    expect(doneOf(events).report?.sections).toEqual({ sales: "ok", appointments: "ok", stock: "ok" });
  });
});

describe("la tarjeta en vivo (base de CA3)", () => {
  it("la pausa llega una sola vez como approval; al aprobar, llegan el resultado de la acción y la respuesta", async () => {
    const actions = fakeActions();
    const graph = buildTestGraph({
      model: new StreamingChatModel([toolCall("a1", "adjustStock", { sku: "CER-001", delta: 5, reason: "reposición" }), new AIMessage("Listo: sumé 5 unidades.")]),
      tools: [stock],
      intent: "action",
      actions: actions.runner,
      checkpointer: new MemorySaver(),
    });
    const paused = await all(streamRunTurn({ graph }, "hilo-accion", "Sumá 5 ceras al stock."));
    expect(paused.filter((e) => e.type === "approval")).toHaveLength(1); // del subgrafo y de la raíz: una sola
    expect(paused.filter((e) => e.type === "tool_start")).toEqual([]); // una acción no es una herramienta: va en la tarjeta
    expect(doneOf(paused).awaiting?.action.params).toEqual({ sku: "CER-001", delta: 5, reason: "reposición" });
    expect(doneOf(paused).reply).toBe("");

    const resumed = await all(streamResumeTurn({ graph }, "hilo-accion", { decision: "approve" }));
    const result = resumed.find((e) => e.type === "action_result");
    expect(result).toMatchObject({ type: "action_result", tool: "adjustStock", ok: true });
    const reply = resumed.find((e) => e.type === "message" && e.kind === "reply");
    expect(reply).toMatchObject({ author: "action_graph", text: "Listo: sumé 5 unidades." });
    expect(resumed.indexOf(result!)).toBeLessThan(resumed.indexOf(reply!));
    expect(resumed.some((e) => e.type === "token")).toBe(true);
    expect(doneOf(resumed).awaiting).toBeUndefined();
    expect(actions.executed).toHaveLength(1);
  });
});

describe("corte a mitad del turno (CA8)", () => {
  it("cortar deja el hilo a medias; continuar lo termina con un solo mensaje de la persona y una sola respuesta", async () => {
    const LONG = "Esta es una respuesta larga que se va escribiendo de a poco para poder cortarla en el medio.";
    const graph = buildTestGraph({
      model: new StreamingChatModel([new AIMessage(LONG), new AIMessage(LONG)], { delayMs: 15 }),
      tools: [],
      intent: "chat",
      checkpointer: new MemorySaver(),
    });
    const controller = new AbortController();
    const seen: UiEvent[] = [];
    await expect(async () => {
      for await (const event of streamRunTurn({ graph }, "hilo-corte", "contame algo", controller.signal)) {
        seen.push(event);
        if (event.type === "token") controller.abort();
      }
    }).rejects.toThrow();
    expect(seen.some((e) => e.type === "done")).toBe(false);

    const cut = await getStatus(graph, "hilo-corte");
    expect(cut.pending).toBe(true);

    const finished = await continueTurn({ graph }, "hilo-corte");
    expect(finished.reply).toBe(LONG);
    const after = await getStatus(graph, "hilo-corte");
    expect(after.pending).toBe(false);
    expect(after.messages.filter((m) => m.type === "human")).toHaveLength(1);
    expect(after.messages.filter((m) => m.type === "ai")).toHaveLength(1);
  });
});

describe("toUiEvents: casos sueltos", () => {
  const sub = ["action_graph:1"];

  it("una pausa dentro del subgrafo no se informa (llega también al grafo principal)", () => {
    const request = { kind: "approve_action", action: { id: "x", toolCallId: "a", tool: "adjustStock", params: {}, risk: "low", summary: "s" } };
    expect(toUiEvents([sub, "updates", { __interrupt__: [{ id: "i", value: request }] }])).toEqual([]);
    expect(toUiEvents([[], "updates", { __interrupt__: [{ id: "i", value: request }] }])).toEqual([{ type: "approval", request }]);
  });

  it("el aviso del plan es un mensaje del supervisor", () => {
    const events = toUiEvents([[], "updates", { supervisor: { activeAgent: null, messages: [new AIMessage({ id: "n1", content: "Hago una acción por mensaje." })] } }]);
    expect(events).toEqual([{ type: "message", id: "n1", author: "supervisor", kind: "notice", text: "Hago una acción por mensaje." }]);
  });

  it("una herramienta que falla termina con ok: false; una acción decidida es action_result", () => {
    expect(toUiEvents([["query_graph:1"], "updates", { tools: { messages: [new ToolMessage({ content: "Error", tool_call_id: "c9", name: "getStockLevels", status: "error" })] } }])).toEqual([
      { type: "tool_end", id: "c9", name: "getStockLevels", ok: false },
    ]);
    expect(toUiEvents([sub, "updates", { execute_action: { messages: [new ToolMessage({ content: "Se registró la venta.", tool_call_id: "a1", name: "registerSale" })] } }])).toEqual([
      { type: "action_result", tool: "registerSale", ok: true, message: "Se registró la venta." },
    ]);
  });

  it("del modo messages solo pasan los fragmentos de texto de los nodos que contestan", () => {
    const chunk = (id: string, text: string) => new AIMessageChunk({ id, content: text });
    expect(toUiEvents([["query_graph:1|agent:2"], "messages", [chunk("m1", "Hola"), { langgraph_node: "agent" }]])).toEqual([{ type: "token", messageId: "m1", agent: "query_graph", text: "Hola" }]);
    expect(toUiEvents([[], "messages", [chunk("m2", "ruta"), { langgraph_node: "router" }]])).toEqual([]);
    expect(toUiEvents([[], "messages", [chunk("m3", "x"), { langgraph_node: "memory" }]])).toEqual([]);
    expect(toUiEvents([["report_graph:1|compose_report:2"], "messages", [chunk("m4", "Lectura"), { langgraph_node: "compose_report" }]])).toEqual([]);
    expect(toUiEvents([["query_graph:1|tools:2"], "messages", [new ToolMessage({ content: "{}", tool_call_id: "c" }), { langgraph_node: "tools" }]])).toEqual([]);
  });

  it("los mensajes de un subgrafo que vuelven juntos al grafo principal no se repiten", () => {
    const events = toUiEvents([[], "updates", { query_graph: { messages: [new HumanMessage("x"), new AIMessage({ id: "r", content: "respuesta" })] } }]);
    expect(events).toEqual([{ type: "agent", agent: "query_graph", status: "end" }]);
  });

  it("una ruta del router", () => {
    expect(toUiEvents([[], "updates", { router: { intent: "query", intentReason: "consulta", plan: { tasks: [{ id: "1", intent: "query", request: "stock", status: "pending" }] } } }])).toEqual([
      { type: "route", reason: "consulta", tasks: [{ intent: "query", request: "stock" }] },
    ]);
  });
});

