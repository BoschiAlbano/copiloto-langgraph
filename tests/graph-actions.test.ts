import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Command, MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../src/graph/approval.js";
import { routeAfterActionAgent, routeAfterApproval, routeAfterPropose, routeAfterTools } from "../src/graph/index.js";
import { makeState } from "../src/graph/state.js";
import { fakeActions } from "./helpers/actions.js";
import { buildTestGraph } from "./helpers/graph.js";
import { scriptedModel, toolCall } from "./helpers/models.js";

// Flujo completo de aprobación con modelos falsos y un ejecutor en memoria (sin base): lo que se prueba
// acá es la mecánica del grafo (pausa, decisión, reanudación). Las reglas del negocio y los efectos en la
// base se prueban en tests/actions-prepare.test.ts y tests/writes/.

let consultas = 0;
const findClient = tool(async () => (consultas++, JSON.stringify({ clients: [{ id: 3, name: "Ana Pérez" }] })), {
  name: "findClient",
  description: "Busca clientes",
  schema: z.strictObject({ query: z.string() }),
});

const THREAD = { configurable: { thread_id: "hilo-acciones" } };
const types = (messages: BaseMessage[]) => messages.map((m) => m.type);

/** Grafo de acciones: el agente de consultas y el de acciones son modelos distintos para ver cuál se usa. */
function setup(actionScript: ConstructorParameters<typeof Array>[0] extends never ? never : Parameters<typeof scriptedModel>[0]) {
  const action = scriptedModel(actionScript);
  const query = scriptedModel([new AIMessage("respuesta de consultas")]);
  const actions = fakeActions();
  const graph = buildTestGraph({
    model: query.model,
    actionModel: action.model,
    tools: [findClient],
    actions: actions.runner,
    intent: "action",
    checkpointer: new MemorySaver(),
  });
  return { graph, action, query, ...actions };
}

const start = (text = "cancelá el turno") => ({ messages: [new HumanMessage(text)] });
const cancelCall = (id = "toolu_1", appointmentId = 7) => toolCall(id, "cancelAppointment", { appointmentId });

/** La solicitud de aprobación que dejó el grafo al pausarse. */
const requestOf = (result: unknown) => (result as { __interrupt__?: { value: unknown }[] }).__interrupt__?.[0]?.value as ApprovalRequest | undefined;

describe("pausa antes de ejecutar (CA1 a)", () => {
  it("una acción pedida por el modelo se convierte en propuesta y el grafo se detiene sin ejecutar nada", async () => {
    const t = setup([cancelCall(), new AIMessage("Listo.")]);
    const result = await t.graph.invoke(start(), THREAD);

    const request = requestOf(result)!;
    expect(request.kind).toBe("approve_action");
    expect(request.action).toMatchObject({ id: "hilo-acciones:toolu_1", toolCallId: "toolu_1", tool: "cancelAppointment", params: { appointmentId: 7 }, risk: "medium" });
    expect(t.executed).toEqual([]);
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.action.calls).toHaveLength(1); // el modelo no vuelve a hablar hasta que haya una decisión

    const state = await t.graph.getState(THREAD);
    expect(state.next).toEqual(["await_approval"]);
    expect(state.values.pendingAction).toMatchObject({ id: "hilo-acciones:toolu_1" });
    expect(state.tasks[0]!.interrupts).toHaveLength(1);
  });

  it("para cada una de las cuatro acciones", async () => {
    const calls = [
      toolCall("a", "createAppointment", { clientId: 3, staffName: "Lucas", serviceName: "Corte", date: "2026-11-23", time: "15:00" }),
      toolCall("b", "cancelAppointment", { appointmentId: 7 }),
      toolCall("c", "registerSale", { paymentMethod: "cash", items: [{ sku: "CER-001", qty: 2 }] }),
      toolCall("d", "adjustStock", { sku: "SHA-001", delta: 20, reason: "Llegó un pedido" }),
    ];
    for (const call of calls) {
      const t = setup([call, new AIMessage("ok")]);
      const result = await t.graph.invoke(start(), { configurable: { thread_id: `hilo-${call.tool_calls![0]!.name}` } });
      expect(requestOf(result)?.action.tool).toBe(call.tool_calls![0]!.name);
      expect(t.execute).not.toHaveBeenCalled();
    }
  });

  it("las consultas previas pasan por tools y vuelven al agente de acciones antes de proponer", async () => {
    consultas = 0;
    const t = setup([toolCall("q1", "findClient", { query: "ana" }), cancelCall("toolu_2"), new AIMessage("Listo.")]);
    const result = await t.graph.invoke(start(), THREAD);
    expect(consultas).toBe(1);
    expect(requestOf(result)?.action.id).toBe("hilo-acciones:toolu_2");
    expect(t.query.calls).toHaveLength(0); // el agente de consultas no participó
  });

  it("un modelo que miente en su texto no cambia lo que lee la persona: el resumen lo arma el código", async () => {
    const liar = new AIMessage({
      content: "Voy a cancelar el turno de Ana, nada más.",
      tool_calls: [{ id: "toolu_9", name: "cancelAppointment", args: { appointmentId: 7 }, type: "tool_call" }],
    });
    const t = setup([liar, new AIMessage("ok")]);
    const result = await t.graph.invoke(start(), THREAD);
    const request = requestOf(result)!;
    expect(request.action.summary).toBe('cancelAppointment {"appointmentId":7}');
    expect(request.action.summary).not.toContain("Ana");
  });
});

describe("decidir y reanudar", () => {
  const paused = async (script = [cancelCall(), new AIMessage("Turno cancelado.")] as AIMessage[]) => {
    const t = setup(script);
    await t.graph.invoke(start(), THREAD);
    return t;
  };
  const decide = (t: Awaited<ReturnType<typeof paused>>, resume: unknown) => t.graph.invoke(new Command({ resume }), THREAD);

  it("aprobar ejecuta exactamente la propuesta, responde a la llamada del modelo y el modelo confirma", async () => {
    const t = await paused();
    const result = await decide(t, { decision: "approve" });

    expect(t.executed).toHaveLength(1);
    expect(t.executed[0]).toMatchObject({ threadId: "hilo-acciones", actionId: "hilo-acciones:toolu_1", tool: "cancelAppointment", params: { appointmentId: 7 }, decision: "approved" });
    expect(types(result.messages)).toEqual(["human", "ai", "tool", "ai"]);
    const toolMessage = result.messages[2] as ToolMessage;
    expect(toolMessage.tool_call_id).toBe("toolu_1");
    expect(toolMessage.text).toContain("Hecho: cancelAppointment");
    expect(result.messages.at(-1)?.text).toBe("Turno cancelado.");
    expect(result.pendingAction).toBeNull();
    expect(result.approval).toBeNull();
    expect((await t.graph.getState(THREAD)).next).toEqual([]);
    // El modelo vio el resultado real antes de contestar.
    expect(t.action.calls[1]!.some((m) => m.type === "tool" && m.text.includes("Hecho:"))).toBe(true);
  });

  it("rechazar (CA2): se registra el rechazo con el comentario y el modelo lo acepta", async () => {
    const t = await paused([cancelCall(), new AIMessage("Entendido, no cancelo nada.")]);
    const result = await decide(t, { decision: "reject", comment: "Todavía no" });
    expect(t.executed).toHaveLength(1);
    expect(t.executed[0]).toMatchObject({ decision: "rejected", comment: "Todavía no" });
    expect(result.messages.at(-1)?.text).toBe("Entendido, no cancelo nada.");
    expect((result.messages.at(-2) as ToolMessage).text).toContain("rechazó");
  });

  it("editar (CA3): se ejecutan los parámetros nuevos y se conservan los propuestos", async () => {
    const t = await paused();
    await decide(t, { decision: "edit", params: { appointmentId: 8 }, comment: "era el otro" });
    expect(t.executed[0]).toMatchObject({
      decision: "edited",
      proposed: { appointmentId: 7 },
      params: { appointmentId: 8 },
      comment: "era el otro",
    });
  });

  it("una edición inválida no ejecuta nada y vuelve a preguntar con el motivo; después se puede corregir", async () => {
    const t = await paused();
    const again = await decide(t, { decision: "edit", params: { appointmentId: "siete" } });
    expect(t.execute).not.toHaveBeenCalled();
    const request = requestOf(again)!;
    expect(request.error).toMatch(/Edición rechazada: Parámetros inválidos para cancelAppointment/);
    expect(request.action.id).toBe("hilo-acciones:toolu_1"); // sigue siendo la misma propuesta
    expect((await t.graph.getState(THREAD)).next).toEqual(["await_approval"]);

    const second = await decide(t, { decision: "edit", params: { appointmentId: 9 } });
    expect(requestOf(second)).toBeUndefined();
    expect(t.executed).toHaveLength(1);
    expect(t.executed[0]).toMatchObject({ decision: "edited", params: { appointmentId: 9 } });
  });

  it("una edición que rompe una regla del negocio también vuelve a preguntar", async () => {
    const t = await paused();
    const again = await decide(t, { decision: "edit", params: { appointmentId: 5, reason: "INVALIDO" } });
    expect(requestOf(again)?.error).toContain("Ese dato no es válido para el negocio.");
    expect(t.execute).not.toHaveBeenCalled();
  });

  it("CA1 c: una decisión mal formada no ejecuta nada y vuelve a preguntar", async () => {
    const bad: unknown[] = [
      "approve",
      "sí",
      42,
      {},
      { decision: "yes" },
      { decision: "approve", params: { appointmentId: 999 } }, // aprobar con parámetros ajenos
      { decision: "approve", extra: true },
      { decision: "reject", comment: 5 },
      { decision: "edit" }, // edición sin parámetros
      { decision: "edit", params: "no es un objeto" },
      { decision: "APPROVE" },
    ];
    for (const resume of bad) {
      const t = await paused();
      const again = await decide(t, resume);
      expect(requestOf(again)?.error, JSON.stringify(resume)).toMatch(/Decisión inválida/);
      expect(t.execute, JSON.stringify(resume)).not.toHaveBeenCalled();
      expect((await t.graph.getState(THREAD)).next).toEqual(["await_approval"]);
    }
  });

  it("una respuesta vacía (null) la rechaza LangGraph antes de entrar al grafo: el hilo sigue pausado y no se ejecuta nada", async () => {
    const t = await paused();
    await expect(decide(t, null)).rejects.toMatchObject({ name: "EmptyInputError" });
    expect(t.execute).not.toHaveBeenCalled();
    expect((await t.graph.getState(THREAD)).next).toEqual(["await_approval"]);
  });

  it("después de una decisión inválida, una válida se ejecuta una sola vez", async () => {
    const t = await paused();
    await decide(t, { decision: "approve", params: { appointmentId: 999 } });
    await decide(t, { decision: "approve" });
    expect(t.executed).toHaveLength(1);
    expect(t.executed[0]!.params).toEqual({ appointmentId: 7 }); // la propuesta guardada, no lo que traía la decisión inválida
  });
});

describe("una acción por vez (CA7)", () => {
  it("varias acciones en un mensaje: ninguna se propone, todas reciben su error y el modelo puede corregir", async () => {
    const many = new AIMessage({
      content: "",
      tool_calls: [
        { id: "a", name: "cancelAppointment", args: { appointmentId: 1 }, type: "tool_call" },
        { id: "b", name: "cancelAppointment", args: { appointmentId: 2 }, type: "tool_call" },
      ],
    });
    const t = setup([many, cancelCall("c"), new AIMessage("Listo.")]);
    const result = await t.graph.invoke(start(), THREAD);

    // El modelo recibió un error por cada llamada y propuso una sola en el intento siguiente.
    const second = t.action.calls[1]!;
    const errors = second.filter((m): m is ToolMessage => m.type === "tool");
    expect(errors.map((m) => m.tool_call_id)).toEqual(["a", "b"]);
    expect(errors.every((m) => m.status === "error")).toBe(true);
    expect(requestOf(result)?.action.id).toBe("hilo-acciones:c");
    expect(t.execute).not.toHaveBeenCalled();
  });

  it("una acción mezclada con una consulta tampoco se propone", async () => {
    const mixed = new AIMessage({
      content: "",
      tool_calls: [
        { id: "a", name: "findClient", args: { query: "ana" }, type: "tool_call" },
        { id: "b", name: "cancelAppointment", args: { appointmentId: 1 }, type: "tool_call" },
      ],
    });
    const t = setup([mixed, new AIMessage("Voy de a una cosa.")]);
    const result = await t.graph.invoke(start(), THREAD);
    expect(requestOf(result)).toBeUndefined();
    expect(t.prepare).not.toHaveBeenCalled();
    expect(types(result.messages)).toEqual(["human", "ai", "tool", "tool", "ai"]);
  });

  it("una propuesta inválida vuelve al modelo como error y no pausa", async () => {
    const t = setup([toolCall("x", "cancelAppointment", { appointmentId: "uno" }), new AIMessage("No pude proponerlo.")]);
    const result = await t.graph.invoke(start(), THREAD);
    expect(requestOf(result)).toBeUndefined();
    expect(result.messages.at(-1)?.text).toBe("No pude proponerlo.");
    expect((result.messages.at(-2) as ToolMessage).status).toBe("error");
    expect(t.execute).not.toHaveBeenCalled();
  });
});

describe("las acciones no se pueden ejecutar por otro camino (CA1 b)", () => {
  it("una acción pedida en la rama de consultas llega a tools y solo produce 'la herramienta no existe'", async () => {
    const query = scriptedModel([cancelCall("zzz"), new AIMessage("No pude.")]);
    const actions = fakeActions();
    const graph = buildTestGraph({ model: query.model, tools: [findClient], actions: actions.runner, intent: "query", checkpointer: new MemorySaver() });
    const result = await graph.invoke(start(), THREAD);

    expect(actions.execute).not.toHaveBeenCalled();
    expect(actions.prepare).not.toHaveBeenCalled();
    const reply = result.messages.find((m: BaseMessage) => m.type === "tool") as ToolMessage;
    expect(reply.status).toBe("error");
    expect(reply.text).toMatch(/not a valid tool|no existe|not found/i);
    expect((await graph.getState(THREAD)).next).toEqual([]);
  });
});

describe("decisiones de ruteo", () => {
  const withCalls = (...names: string[]) =>
    makeState([new AIMessage({ content: "", tool_calls: names.map((name, i) => ({ id: `${i}`, name, args: {}, type: "tool_call" as const })) })]);

  it("routeAfterActionAgent: nada → fin; consultas → tools; cualquier acción → propose_action", () => {
    expect(routeAfterActionAgent(makeState([new AIMessage("hola")]))).toBe("__end__");
    expect(routeAfterActionAgent(withCalls("findClient", "listAppointments"))).toBe("tools");
    expect(routeAfterActionAgent(withCalls("cancelAppointment"))).toBe("propose_action");
    expect(routeAfterActionAgent(withCalls("findClient", "adjustStock"))).toBe("propose_action");
  });

  it("routeAfterTools vuelve al agente que preguntó, según la intención", () => {
    expect(routeAfterTools(makeState([], { intent: "action" }))).toBe("action_agent");
    for (const intent of ["query", "chat", "report", "unclear", undefined] as const) {
      expect(routeAfterTools(makeState([], { intent }))).toBe("agent");
    }
  });

  it("routeAfterPropose y routeAfterApproval", () => {
    const pending = { id: "x", toolCallId: "t", tool: "adjustStock" as const, params: {}, risk: "low" as const, summary: "s" };
    expect(routeAfterPropose(makeState([], { pendingAction: pending }))).toBe("await_approval");
    expect(routeAfterPropose(makeState([], { pendingAction: null }))).toBe("action_agent");
    expect(routeAfterApproval(makeState([], { approval: { actionId: "x", decision: "invalid" } }))).toBe("await_approval");
    for (const decision of ["approved", "rejected", "edited"] as const) {
      expect(routeAfterApproval(makeState([], { approval: { actionId: "x", decision } }))).toBe("execute_action");
    }
  });
});
