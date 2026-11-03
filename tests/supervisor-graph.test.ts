import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Command, END, MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { afterAll, describe, expect, it } from "vitest";
import { supervise } from "../src/graph/nodes/supervisor.js";
import { secondActionNotice, type Plan } from "../src/graph/plan.js";
import { resumeTurn, runTurn, turnReply } from "../src/graph/run-turn.js";
import { getStatus } from "../src/graph/threads.js";
import { fakeActions } from "./helpers/actions.js";
import { checkpointsUrl, openCheckpointing } from "./helpers/checkpointing.js";
import { buildTestGraph, planned } from "./helpers/graph.js";
import { scriptedModel, toolCall } from "./helpers/models.js";
import { TestThreads } from "./helpers/threads.js";

// Fase 7: el supervisor reparte un pedido de varias partes entre los agentes, con modelos falsos.
// Con el modelo real y la base: tests/writes/mixed.llm.test.ts.

const task = (id: string, intent: Plan["tasks"][number]["intent"], status: Plan["tasks"][number]["status"]) => ({ id, intent, request: `parte ${id}`, status });

describe("supervise", () => {
  const human = [new HumanMessage("x")];

  it("despacha la primera tarea pendiente a su agente, con la cantidad de mensajes del hilo", () => {
    const cmd = supervise({ messages: human, plan: { tasks: [task("1", "action", "pending"), task("2", "query", "pending")] } });
    expect(cmd.goto).toEqual(["action_graph"]);
    expect(cmd.update).toMatchObject({ activeAgent: "action_graph", plan: { tasks: [{ status: "running", startedAt: 1 }, { status: "pending" }] } });
  });

  it("cuando vuelve un agente, cierra su tarea y pasa a la siguiente", () => {
    const messages = [...human, new AIMessage("hecho")];
    const cmd = supervise({ messages, plan: { tasks: [task("1", "action", "running"), task("2", "report", "pending")] } });
    expect(cmd.goto).toEqual(["report_graph"]);
    expect(cmd.update).toMatchObject({ plan: { tasks: [{ status: "done" }, { status: "running", startedAt: 2 }] } });
  });

  it("sin tareas pendientes termina el turno y deja sin agente activo", () => {
    const cmd = supervise({ messages: human, plan: { tasks: [task("1", "query", "running")] } });
    expect(cmd.goto).toEqual([END]);
    expect(cmd.update).toEqual({ plan: { tasks: [{ ...task("1", "query", "done") }] }, activeAgent: null });
  });

  it("al terminar agrega el aviso del plan como un mensaje más", () => {
    const cmd = supervise({ messages: human, plan: { tasks: [task("1", "action", "running")], notice: "aviso" } });
    const update = cmd.update as { messages: BaseMessage[] };
    expect(update.messages.map((m) => m.text)).toEqual(["aviso"]);
  });

  it("sin plan (no debería pasar) termina sin hacer nada", () => {
    expect(supervise({ messages: human }).goto).toEqual([END]);
  });
});

describe("turnReply", () => {
  it("junta las respuestas de cada agente, sin el texto que acompaña a una llamada a herramienta", () => {
    const withCall = new AIMessage({ content: "voy a consultar", tool_calls: [{ id: "1", name: "x", args: {}, type: "tool_call" }] });
    expect(turnReply([withCall, new AIMessage("Venta registrada."), new AIMessage("  "), new AIMessage("Quedan 11.")])).toBe("Venta registrada.\n\nQuedan 11.");
  });
});

let stockReads = 0;
const getStockLevels = tool(async () => (stockReads++, JSON.stringify({ products: [{ sku: "GEL-001", stock: 11 }] })), {
  name: "getStockLevels",
  description: "Stock",
  schema: z.strictObject({}),
});
const sale = () => toolCall("toolu_venta", "registerSale", { paymentMethod: "cash", items: [{ sku: "GEL-001", qty: 1 }] });
const M1 = planned(["action", "registrá la venta de un gel en efectivo"], ["query", "decime cuánto stock queda del gel"]);

/** El grafo completo con un pedido mixto: el agente de acciones y el de consultas son modelos distintos. */
function mixed(actionScript: AIMessage[], options: { router?: Parameters<typeof buildTestGraph>[0]["intent"]; saver?: MemorySaver } = {}) {
  const action = scriptedModel(actionScript);
  const query = scriptedModel([toolCall("q1", "getStockLevels"), new AIMessage("Quedan 11 geles.")]);
  const actions = fakeActions();
  const graph = buildTestGraph({
    model: query.model,
    actionModel: action.model,
    tools: [getStockLevels],
    actions: actions.runner,
    intent: options.router ?? M1,
    checkpointer: options.saver ?? new MemorySaver(),
  });
  return { agent: { graph }, graph, action, query, ...actions };
}

describe("pedido mixto (CA2): acción y después consulta, en el mismo turno", () => {
  it("pasa por action_graph, se pausa en la aprobación, y al aprobar sigue con query_graph", async () => {
    stockReads = 0;
    const t = mixed([sale(), new AIMessage("Venta registrada.")]);
    const paused = await runTurn(t.agent, "hilo-mixto", "Registrá la venta de un gel en efectivo y decime cuánto stock queda.");

    expect(paused.awaiting?.action.tool).toBe("registerSale");
    expect(paused.reply).toBe("");
    expect(paused.route.tasks?.map((x) => x.intent)).toEqual(["action", "query"]);
    expect(t.query.calls).toHaveLength(0); // la consulta espera a que se decida la acción
    expect(stockReads).toBe(0);

    const state = await t.graph.getState({ configurable: { thread_id: "hilo-mixto" } });
    expect(state.next).toEqual(["action_graph"]);
    expect(state.values.activeAgent).toBe("action_graph");
    expect(state.values.plan!.tasks.map((x: { status: string }) => x.status)).toEqual(["running", "pending"]);

    const done = await resumeTurn(t.agent, "hilo-mixto", { decision: "approve" });
    expect(t.executed).toHaveLength(1);
    expect(stockReads).toBe(1); // la consulta corrió DESPUÉS de ejecutar la venta
    expect(done.reply).toBe("Venta registrada.\n\nQuedan 11 geles.");
    // El uso del turno reanudado no repite la consulta de antes de la pausa: lista lo que pasó después.
    expect(done.summary.toolCalls.map((c) => c.name)).toEqual(["getStockLevels"]);

    const final = await t.graph.getState({ configurable: { thread_id: "hilo-mixto" } });
    expect(final.next).toEqual([]);
    expect(final.values.activeAgent).toBeNull();
    expect(final.values.plan!.tasks.map((x: { status: string }) => x.status)).toEqual(["done", "done"]);
  });

  it("cada agente recibe su parte; el segundo, además, la indicación de seguir después de la respuesta del primero", async () => {
    const t = mixed([sale(), new AIMessage("Venta registrada.")]);
    await runTurn(t.agent, "hilo-mixto-2", "registrá y decime");
    await resumeTurn(t.agent, "hilo-mixto-2", { decision: "approve" });

    expect(t.action.calls[0]![0]!.text).toContain("A vos te toca solo esto: «registrá la venta de un gel en efectivo»");
    const [system, ...rest] = t.query.calls[0]!;
    expect(system!.text).toContain("A vos te toca solo esto: «decime cuánto stock queda del gel»");
    // persona, propuesta de la venta, resultado, respuesta del agente de acciones, indicación (no guardada)
    expect(rest.map((m) => m.type)).toEqual(["human", "ai", "tool", "ai", "human"]);
    expect(rest.at(-1)!.text).toContain("Seguí con tu parte del pedido");
    const saved = (await t.graph.getState({ configurable: { thread_id: "hilo-mixto-2" } })).values.messages;
    expect(saved.some((m: BaseMessage) => m.text.includes("Seguí con tu parte"))).toBe(false);
  });

  it("CA4: ni durante la pausa ni al final el estado principal tiene la propuesta, la decisión o las partes; la tarjeta sale del subgrafo", async () => {
    const t = mixed([sale(), new AIMessage("Venta registrada.")]);
    const config = { configurable: { thread_id: "hilo-privado" } };
    await runTurn(t.agent, "hilo-privado", "registrá y decime");

    const during = await t.graph.getState(config);
    for (const field of ["pendingAction", "approval", "reportParts"]) expect(during.values, field).not.toHaveProperty(field);
    const status = await getStatus(t.graph, "hilo-privado");
    expect(status.awaiting?.action).toMatchObject({ id: "hilo-privado:toolu_venta", tool: "registerSale" });
    expect(status.next).toEqual(["action_graph/await_approval"]);

    await resumeTurn(t.agent, "hilo-privado", { decision: "approve" });
    const after = await t.graph.getState(config);
    for (const field of ["pendingAction", "approval", "reportParts"]) expect(after.values, field).not.toHaveProperty(field);
  });
});

describe("CA7: la acción no frena el resto del pedido", () => {
  it("si se rechaza la acción, la consulta se hace igual y no se ejecuta nada", async () => {
    stockReads = 0;
    const t = mixed([sale(), new AIMessage("Entendido, no registro la venta.")]);
    await runTurn(t.agent, "hilo-rechazo", "registrá y decime");
    const done = await resumeTurn(t.agent, "hilo-rechazo", { decision: "reject" });
    expect(t.executed.map((e) => e.decision)).toEqual(["rejected"]); // solo queda el registro del rechazo
    expect(stockReads).toBe(1);
    expect(done.reply).toBe("Entendido, no registro la venta.\n\nQuedan 11 geles.");
  });

  it("si el agente de acciones termina con una pregunta, no hay tarjeta y la consulta también se hace", async () => {
    stockReads = 0;
    const t = mixed([new AIMessage("¿Con qué medio de pago?")]);
    const turn = await runTurn(t.agent, "hilo-pregunta", "registrá y decime");
    expect(turn.awaiting).toBeUndefined();
    expect(t.prepare).not.toHaveBeenCalled();
    expect(stockReads).toBe(1);
    expect(turn.reply).toBe("¿Con qué medio de pago?\n\nQuedan 11 geles.");
  });

  it("una segunda acción en el mismo mensaje no se hace: se avisa al final", async () => {
    const t = mixed([sale(), new AIMessage("Venta registrada.")], {
      router: planned(["action", "registrá la venta"], ["action", "descontá tres peines"]),
    });
    await runTurn(t.agent, "hilo-dos-acciones", "registrá la venta y descontá tres peines");
    const done = await resumeTurn(t.agent, "hilo-dos-acciones", { decision: "approve" });
    expect(t.executed).toHaveLength(1);
    expect(done.reply).toBe(`Venta registrada.\n\n${secondActionNotice("descontá tres peines")}`);
  });
});

describe("pedido mixto con reporte", () => {
  it("acción y reporte: la terminal recibe el estado de las secciones aunque el reporte sea la segunda tarea", async () => {
    const actions = fakeActions();
    const graph = buildTestGraph({
      model: scriptedModel(() => new AIMessage("• Lectura.")).model,
      actionModel: scriptedModel([sale(), new AIMessage("Venta registrada.")]).model,
      tools: [],
      actions: actions.runner,
      intent: planned(["action", "registrá la venta"], ["report", "resumen de la semana"]),
      reportPlan: { async invoke() { return { parsed: { reason: "x", kind: "this_week" } }; } },
      reportSections: async (section, reportId) => ({ reportId, section, status: "error", error: "sin datos" }),
      now: () => new Date("2026-10-28T15:00:00Z"),
      checkpointer: new MemorySaver(),
    });
    await runTurn({ graph }, "hilo-accion-reporte", "registrá la venta y armame el resumen");
    const done = await resumeTurn({ graph }, "hilo-accion-reporte", { decision: "approve" });
    expect(done.report).toEqual({ label: "semana del 26/10 al 01/11", sections: { sales: "error", appointments: "error", stock: "error" } });
    expect(done.reply).toMatch(/^Venta registrada\.\n\nReporte · semana/);
  });
});

describe.skipIf(!checkpointsUrl)("CA8: un pedido mixto pausado sobrevive a un reinicio (Postgres)", () => {
  const threads = new TestThreads();
  afterAll(async () => {
    const cp = openCheckpointing();
    await threads.cleanup(cp.saver);
    await cp.close();
  });

  it("tras reiniciar se ve la tarjeta, aprobar ejecuta la acción y después la consulta que faltaba; el turno siguiente arranca con otro plan", async () => {
    const id = threads.fresh("mixto");
    stockReads = 0;
    const first = openCheckpointing();
    const actionsA = fakeActions();
    const graphA = buildTestGraph({
      model: scriptedModel([]).model,
      actionModel: scriptedModel([sale()]).model,
      tools: [getStockLevels],
      actions: actionsA.runner,
      intent: M1,
      checkpointer: first.saver,
    });
    await runTurn({ graph: graphA }, id, "Registrá la venta y decime el stock.");
    await first.close(); // el programa se cierra esperando la decisión

    const second = openCheckpointing();
    const actionsB = fakeActions();
    const query = scriptedModel([toolCall("q1", "getStockLevels"), new AIMessage("Quedan 11 geles."), new AIMessage("¡De nada!")]);
    const graphB = buildTestGraph({
      model: query.model,
      actionModel: scriptedModel([new AIMessage("Venta registrada.")]).model,
      tools: [getStockLevels],
      actions: actionsB.runner,
      intent: "chat", // al reanudar no se llama al router: el turno ya tiene su plan
      checkpointer: second.saver,
    });
    const status = await getStatus(graphB, id);
    expect(status.awaiting?.action.tool).toBe("registerSale");

    const done = await resumeTurn({ graph: graphB }, id, { decision: "approve" });
    expect(actionsB.executed).toHaveLength(1);
    expect(stockReads).toBe(1);
    expect(done.reply).toBe("Venta registrada.\n\nQuedan 11 geles.");

    const next = await runTurn({ graph: graphB }, id, "gracias");
    expect(next.route.tasks).toEqual([{ intent: "chat", request: "gracias" }]); // plan nuevo: solo la charla de este mensaje
    expect(next.reply).toBe("¡De nada!");
    await second.close();
  });
});

it("Command: el supervisor devuelve actualización y destino juntos", () => {
  expect(supervise({ messages: [], plan: { tasks: [task("1", "chat", "pending")] } })).toBeInstanceOf(Command);
});
