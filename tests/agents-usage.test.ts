import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { describeAgents } from "../src/cli/format.js";
import type { RouterModel } from "../src/graph/nodes/router.js";
import type { Plan } from "../src/graph/plan.js";
import { resumeTurn, runTurn, type TurnResult } from "../src/graph/run-turn.js";
import { agentSteps } from "../src/graph/usage.js";
import { mergeUsage, runKeyOf, totalUsage, UsageTracker } from "../src/graph/usage-tracker.js";
import { fakeActions } from "./helpers/actions.js";
import { buildTestGraph, planned } from "./helpers/graph.js";
import { toolCall, TrackedChatModel } from "./helpers/models.js";

// R10b y CA12 (fase 7): qué agentes intervinieron en el turno, con sus herramientas y su uso.

describe("runKeyOf", () => {
  it("toma el primer tramo del espacio de nombres: la corrida del grafo principal", () => {
    expect(runKeyOf({ langgraph_checkpoint_ns: "router:88ea" })).toBe("router:88ea");
    expect(runKeyOf({ langgraph_checkpoint_ns: "query_graph:dfa9|agent:8e28" })).toBe("query_graph:dfa9");
    expect(runKeyOf({})).toBe("desconocido");
    expect(runKeyOf(undefined)).toBe("desconocido");
  });
});

describe("UsageTracker por corrida", () => {
  const end = (model: string, input: number, output: number) => ({
    generations: [[{ text: "", message: new AIMessage({ content: "", response_metadata: { model }, usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output } }) }]],
  });
  const start = (t: UsageTracker, runId: string, ns: string) => t.handleChatModelStart({}, [], runId, undefined, undefined, undefined, { langgraph_checkpoint_ns: ns });

  it("agrupa las llamadas por corrida, en el orden en que empezaron, y por modelo", () => {
    const t = new UsageTracker();
    start(t, "a", "router:1");
    t.handleLLMEnd(end("claude-haiku-5-5", 700, 30), "a");
    start(t, "b", "action_graph:2|action_agent:x");
    t.handleLLMEnd(end("claude-sonnet-5-5", 4000, 80), "b");
    start(t, "c", "query_graph:3|agent:y");
    start(t, "d", "action_graph:2|action_agent:z"); // la misma corrida de acciones, otra llamada
    t.handleLLMEnd(end("claude-sonnet-5-5", 3000, 60), "c");
    t.handleLLMEnd(end("claude-sonnet-5-5", 4100, 90), "d");

    expect(t.runs()).toEqual([
      { node: "router", usage: [{ model: "claude-haiku-5-5", calls: 1, inputTokens: 700, outputTokens: 30 }] },
      { node: "action_graph", usage: [{ model: "claude-sonnet-5-5", calls: 2, inputTokens: 8100, outputTokens: 170 }] },
      { node: "query_graph", usage: [{ model: "claude-sonnet-5-5", calls: 1, inputTokens: 3000, outputTokens: 60 }] },
    ]);
    // El total por modelo es la suma de las corridas.
    expect(totalUsage(t.usage())).toEqual(totalUsage(mergeUsage(...t.runs().map((r) => r.usage))));
  });

  it("con streaming (fase 9) la respuesta puede no traer el modelo: se usa el que se pidió al empezar", () => {
    const t = new UsageTracker();
    t.handleChatModelStart({}, [], "s", undefined, undefined, undefined, { langgraph_checkpoint_ns: "chat:1", ls_model_name: "claude-haiku-5-5" });
    t.handleLLMEnd({ generations: [[{ text: "", message: new AIMessage({ content: "hola", usage_metadata: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } }) }]] } as never, "s");
    t.handleChatModelStart({}, [], "u", undefined, { invocation_params: { model: "claude-sonnet-5-5" } }, undefined, { langgraph_checkpoint_ns: "chat:1" });
    t.handleLLMEnd({ generations: [[{ text: "", message: new AIMessage({ content: "chau", usage_metadata: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } }) }]] } as never, "u");
    expect(t.usage()).toEqual([
      { model: "claude-haiku-5-5", calls: 1, inputTokens: 50, outputTokens: 5 },
      { model: "claude-sonnet-5-5", calls: 1, inputTokens: 10, outputTokens: 1 },
    ]);
  });

  it("una llamada sin metadatos (fuera de un grafo) cuenta igual, como corrida desconocida", () => {
    const t = new UsageTracker();
    t.handleLLMEnd(end("claude-haiku-5-5", 10, 1));
    expect(t.runs()).toEqual([{ node: "desconocido", usage: [{ model: "claude-haiku-5-5", calls: 1, inputTokens: 10, outputTokens: 1 }] }]);
  });
});

describe("agentSteps", () => {
  const plan: Plan = {
    tasks: [
      { id: "1", intent: "action", request: "registrá la venta", status: "done", startedAt: 1 },
      { id: "2", intent: "query", request: "decime el stock", status: "done", startedAt: 5 },
    ],
  };
  const messages = [
    new HumanMessage("registrá y decime"),
    toolCall("c1", "getStockLevels"), // acciones, antes de la pausa
    new ToolMessage({ content: "{}", tool_call_id: "c1" }),
    toolCall("c2", "registerSale"),
    new AIMessage("Venta registrada."), // (el resultado de la venta se omite: no es una llamada)
    toolCall("c3", "getStockLevels"), // consultas
    new ToolMessage({ content: "{}", tool_call_id: "c3" }),
    new AIMessage("Quedan 24."),
  ];
  const use = (calls: number) => [{ model: "claude-haiku-5-5", calls, inputTokens: calls * 100, outputTokens: calls * 10 }];

  it("asigna a cada agente las herramientas de su tarea y separa la coordinación", () => {
    const steps = agentSteps({
      plan,
      messages,
      already: 1,
      runs: [{ node: "router", usage: use(1) }, { node: "action_graph", usage: use(3) }, { node: "query_graph", usage: use(2) }],
    });
    expect(steps.coordination).toEqual(use(1));
    expect(steps.agents).toEqual([
      { agent: "action_graph", tools: ["getStockLevels", "registerSale"], usage: use(3) },
      { agent: "query_graph", tools: ["getStockLevels"], usage: use(2) },
    ]);
  });

  it("al reanudar, solo cuenta lo que pasó después de la pausa", () => {
    const steps = agentSteps({ plan, messages, already: 4, runs: [{ node: "action_graph", usage: use(1) }, { node: "query_graph", usage: use(2) }] });
    expect(steps.agents.map((a) => [a.agent, a.tools])).toEqual([["action_graph", []], ["query_graph", ["getStockLevels"]]]);
    expect(steps.coordination).toEqual([]);
  });

  it("si el turno quedó en pausa, el agente de acciones lo indica", () => {
    const paused = agentSteps({ plan, messages: messages.slice(0, 4), already: 1, runs: [{ node: "action_graph", usage: use(2) }], awaiting: true });
    expect(paused.agents).toEqual([{ agent: "action_graph", tools: ["getStockLevels", "registerSale"], usage: use(2), waiting: true }]);
  });
});

describe("describeAgents", () => {
  const use = (model: string, calls: number, input: number, output: number) => [{ model, calls, inputTokens: input, outputTokens: output }];

  it("con un solo agente: el orden, la coordinación y el agente", () => {
    const lines = describeAgents({
      coordination: use("claude-haiku-5-5", 1, 2000, 40),
      agents: [{ agent: "query_graph", tools: ["listAppointments"], usage: use("claude-haiku-5-5", 2, 7000, 200) }],
    });
    expect(lines).toEqual([
      "[agentes] consultas",
      "          coordinación (router): 1 llamada(s) · 2.000 / 40 tokens · US$ 0,0002",
      "          consultas: listAppointments · 2 llamada(s) · 7.000 / 200 tokens · US$ 0,0008",
    ]);
  });

  it("con varios: numerados, y la pausa a la vista", () => {
    const lines = describeAgents({
      coordination: [],
      agents: [
        { agent: "action_graph", tools: ["getStockLevels", "registerSale"], usage: use("claude-haiku-5-5", 2, 8000, 100), waiting: true },
      ],
    });
    expect(lines[1]).toBe("          acciones: getStockLevels, registerSale · 2 llamada(s) · 8.000 / 100 tokens · US$ 0,0008 · ⏸ espera tu decisión");
    const two = describeAgents({
      coordination: [],
      agents: [
        { agent: "action_graph", tools: [], usage: use("claude-haiku-5-5", 1, 4000, 50) },
        { agent: "report_graph", tools: [], usage: use("claude-haiku-5-5", 2, 3000, 300) },
      ],
    });
    expect(two[0]).toBe("[agentes] acciones → reportes");
    expect(two[1]).toMatch(/^ {10}1\. acciones: 1 llamada/);
    expect(two[2]).toMatch(/^ {10}2\. reportes: 2 llamada/);
  });

  it("sin llamadas al modelo no muestra nada", () => {
    expect(describeAgents({ agents: [], coordination: [] })).toEqual([]);
  });
});

describe("CA12: el desglose de un turno real del grafo (modelos falsos que disparan callbacks)", () => {
  const getStockLevels = tool(async () => JSON.stringify({ products: [{ sku: "GEL-001", stock: 24 }] }), {
    name: "getStockLevels",
    description: "Stock",
    schema: z.strictObject({}),
  });
  /** Un router que pasa por un modelo de chat (así su llamada se registra) y devuelve el plan. */
  const trackedRouter = (output: unknown): RouterModel =>
    new TrackedChatModel([new AIMessage(JSON.stringify(output))], "claude-haiku-5-5", { input: 2000, output: 40 }).pipe(
      RunnableLambda.from((m: AIMessage) => ({ parsed: JSON.parse(m.text) as unknown })),
    );
  const sumOf = (turn: TurnResult) => totalUsage(mergeUsage(turn.coordination, ...turn.agents.map((a) => a.usage)));

  it("pedido mixto: acciones (en pausa) y, al aprobar, acciones y consultas; cada parte suma lo mismo que el total", async () => {
    const graph = buildTestGraph({
      router: trackedRouter(planned(["action", "registrá la venta"], ["query", "decime el stock"])),
      model: new TrackedChatModel([toolCall("q1", "getStockLevels"), new AIMessage("Quedan 24.")], "claude-haiku-5-5", { input: 900, output: 30 }),
      actionModel: new TrackedChatModel(
        [toolCall("s1", "registerSale", { paymentMethod: "cash", items: [{ sku: "GEL-001", qty: 1 }] }), new AIMessage("Venta registrada.")],
        "claude-sonnet-5-5",
        { input: 4000, output: 80 },
      ),
      tools: [getStockLevels],
      actions: fakeActions().runner,
      checkpointer: new MemorySaver(),
    });

    const paused = await runTurn({ graph }, "hilo-agentes", "registrá la venta y decime el stock");
    expect(paused.agents).toEqual([
      { agent: "action_graph", tools: ["registerSale"], usage: [{ model: "claude-sonnet-5-5", calls: 1, inputTokens: 4000, outputTokens: 80 }], waiting: true },
    ]);
    expect(paused.coordination).toEqual([{ model: "claude-haiku-5-5", calls: 1, inputTokens: 2000, outputTokens: 40 }]);
    expect(sumOf(paused)).toEqual(totalUsage(paused.summary.usage));

    const done = await resumeTurn({ graph }, "hilo-agentes", { decision: "approve" });
    expect(done.agents.map((a) => [a.agent, a.tools])).toEqual([["action_graph", []], ["query_graph", ["getStockLevels"]]]);
    expect(done.coordination).toEqual([]); // al reanudar no se vuelve a llamar al router
    expect(sumOf(done)).toEqual(totalUsage(done.summary.usage));
    expect(describeAgents(done)[0]).toBe("[agentes] acciones → consultas");
  });
});
