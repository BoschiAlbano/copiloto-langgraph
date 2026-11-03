import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { buildGraph, routeByIntent } from "../src/graph/index.js";
import { INTENTS, type Intent } from "../src/graph/intents.js";
import { AGENT_RECURSION_LIMIT } from "../src/graph/limits.js";
import type { AgentModel } from "../src/graph/nodes/agent.js";
import type { RouterModel } from "../src/graph/nodes/router.js";
import { makeState } from "../src/graph/state.js";
import { routed, unexpectedActions } from "./helpers/graph.js";

/** Modelo de texto falso: contesta con un texto fijo y cuenta las llamadas. */
function textModel(text: string) {
  const model = { calls: 0, async invoke() { model.calls++; return new AIMessage(text); } };
  return model satisfies AgentModel & { calls: number };
}

/** Router falso que devuelve, una por llamada, las salidas indicadas (la última se repite). */
function scriptedRouter(outputs: unknown[]) {
  const router = {
    calls: 0,
    async invoke() {
      const out = outputs[Math.min(router.calls, outputs.length - 1)];
      router.calls++;
      if (out instanceof Error) throw out;
      return out as { parsed?: unknown };
    },
  };
  return router satisfies RouterModel & { calls: number };
}
const emptySales = {
  salesCount: 0,
  totalRevenue: 0,
  averageTicket: 0,
  byPaymentMethod: [],
  byItemType: { products: { units: 0, revenue: 0 }, services: { units: 0, revenue: 0 } },
};
const route = (intent: Intent) => ({ parsed: routed(intent, `motivo ${intent}`) });

let toolRuns = 0;
const getStock = tool(async () => { toolRuns++; return JSON.stringify({ lowCount: 2 }); }, {
  name: "getStock", description: "Stock bajo", schema: z.strictObject({}),
});
const toolCall = (id: string) =>
  new AIMessage({ content: "", tool_calls: [{ id, name: "getStock", args: {}, type: "tool_call" }] });

/** Arma el grafo con un modelo distinto por rama, para ver cuál se usó. */
function setup(routerOutputs: unknown[], agentReplies?: AIMessage[] | ((callNumber: number) => AIMessage)) {
  const router = scriptedRouter(routerOutputs);
  const chat = textModel("respuesta de charla");
  const clarify = textModel("¿A qué turno te referís?");
  const agent: AgentModel & { calls: number } = {
    calls: 0,
    async invoke() {
      const n = agent.calls++;
      if (!agentReplies) return new AIMessage("respuesta del agente");
      // Un modelo real devuelve un mensaje nuevo en cada llamada: reutilizar la misma instancia
      // haría que el reducer (que identifica mensajes por id) la reemplace en vez de agregarla.
      return typeof agentReplies === "function" ? agentReplies(n) : agentReplies[Math.min(n, agentReplies.length - 1)]!;
    },
  };
  const action = textModel("respuesta del agente de acciones");
  const warn = vi.fn();
  const reportPlan = { calls: 0, async invoke() { reportPlan.calls++; return { parsed: { reason: "pide la semana", kind: "this_week" } }; } };
  const report = textModel("Lectura de prueba");
  const sections: string[] = [];
  const graph = buildGraph({
    models: { router, agent, action, chat, clarify, reportPlan, report },
    tools: [getStock],
    actions: unexpectedActions,
    reportSections: async (section, reportId) => {
      sections.push(section);
      return { reportId, section, status: "ok", data: section === "sales" ? emptySales : section === "appointments" ? { total: 0, activeCount: 0, countByStatus: {} } : { total: 15, lowCount: 0, low: [] } };
    },
    warn,
  });
  return { graph, router, agent, action, chat, clarify, reportPlan, report, sections, warn };
}

/** Corre un turno y devuelve los nodos recorridos, en orden, y el estado final. */
async function runPath(graph: ReturnType<typeof setup>["graph"], messages: BaseMessage[], recursionLimit = AGENT_RECURSION_LIMIT) {
  const path: string[] = [];
  let state: Awaited<ReturnType<typeof graph.invoke>> | undefined;
  for await (const [mode, chunk] of await graph.stream({ messages }, { streamMode: ["updates", "values"], recursionLimit })) {
    if (mode === "updates") path.push(...Object.keys(chunk as object));
    else state = chunk as typeof state;
  }
  return { path, state: state! };
}

const ask = (text = "hola") => [new HumanMessage(text)];

describe("cada intención llega a su rama (CA5)", () => {
  const expectedPath: Record<Intent, string[]> = {
    query: ["router", "agent"],
    chat: ["router", "chat"],
    action: ["router", "action_agent"],
    report: ["router", "plan_report", "report_appointments", "report_sales", "report_stock", "compose_report"],
    unclear: ["router", "clarify"],
  };

  for (const intent of INTENTS) {
    it(`${intent} → ${expectedPath[intent].join(" → ")}`, async () => {
      const t = setup([route(intent)]);
      const { path, state } = await runPath(t.graph, ask());
      // Las tres secciones del reporte corren en el mismo paso: su orden entre sí no está definido, por eso se ordenan.
      const sectionNodes = path.filter((n) => n.startsWith("report_")).sort();
      const comparable = intent === "report" ? [...path.filter((n) => !n.startsWith("report_")).slice(0, 2), ...sectionNodes, "compose_report"] : path;
      expect(comparable).toEqual(expectedPath[intent]);
      expect(state.intent).toBe(intent);
      expect(state.intentReason).toBe(`motivo ${intent}`);
      expect(state.messages.at(-1)).toBeInstanceOf(AIMessage);
    });
  }

  it("la consulta con herramientas recorre router → agent → tools → agent", async () => {
    const t = setup([route("query")], [toolCall("1"), new AIMessage("Hay 2 productos bajos.")]);
    const { path, state } = await runPath(t.graph, ask("¿stock bajo?"));
    expect(path).toEqual(["router", "agent", "tools", "agent"]);
    expect(state.messages.at(-1)?.text).toBe("Hay 2 productos bajos.");
  });
});

describe("solo se usa el modelo de la rama elegida", () => {
  it("charla: no corre el nodo tools ni el agente (CA4)", async () => {
    toolRuns = 0;
    const t = setup([route("chat")]);
    const { path } = await runPath(t.graph, ask("Hola, buen día."));
    expect(path).not.toContain("tools");
    expect(toolRuns).toBe(0);
    expect([t.router.calls, t.chat.calls, t.agent.calls, t.clarify.calls]).toEqual([1, 1, 0, 0]);
  });

  it("aclaración: usa solo el modelo de aclaración y devuelve su pregunta", async () => {
    const t = setup([route("unclear")]);
    const { state } = await runPath(t.graph, ask("Cancelalo."));
    expect([t.router.calls, t.clarify.calls, t.agent.calls, t.chat.calls]).toEqual([1, 1, 0, 0]);
    expect(state.messages.at(-1)?.text).toBe("¿A qué turno te referís?");
  });

  it("reporte: usa el planificador y la «Lectura», y ninguno de los modelos de las otras ramas", async () => {
    const t = setup([route("report")]);
    const { state, path } = await runPath(t.graph, ask("armame el resumen"));
    expect(path[0]).toBe("router");
    expect(path[1]).toBe("plan_report");
    expect(path.at(-1)).toBe("compose_report");
    expect(state.messages.at(-1)?.text).toContain("Reporte ·");
    expect([t.router.calls, t.reportPlan.calls, t.report.calls]).toEqual([1, 1, 1]);
    expect([t.agent.calls, t.action.calls, t.chat.calls, t.clarify.calls]).toEqual([0, 0, 0, 0]);
  });

  it("acción: usa solo el agente de acciones (y no el de consultas), y una respuesta sin llamadas termina el turno", async () => {
    const t = setup([route("action")]);
    const { state, path } = await runPath(t.graph, ask("pedido de cambio"));
    expect(path).toEqual(["router", "action_agent"]);
    expect(state.messages.at(-1)?.text).toBe("respuesta del agente de acciones");
    expect([t.router.calls, t.action.calls, t.agent.calls, t.chat.calls, t.clarify.calls]).toEqual([1, 1, 0, 0, 0]);
  });
});

describe("el router decide de nuevo en cada turno", () => {
  it("intent se reemplaza entre turnos", async () => {
    const t = setup([route("query"), route("chat")]);
    const turn1 = await runPath(t.graph, ask("¿cuántos turnos hay?"));
    expect(turn1.state.intent).toBe("query");
    const turn2 = await runPath(t.graph, [...turn1.state.messages, new HumanMessage("gracias")]);
    expect(turn2.state.intent).toBe("chat");
    expect(turn2.path).toEqual(["router", "chat"]);
  });
});

describe("fallas del router (CA7)", () => {
  it("una salida inválida sigue por query y avisa", async () => {
    const t = setup([{ parsed: null }]);
    const { path, state } = await runPath(t.graph, ask());
    expect(path).toEqual(["router", "agent"]);
    expect(state.intent).toBe("query");
    expect(t.warn).toHaveBeenCalledOnce();
  });

  it("un error de la API llega a quien invoca el grafo", async () => {
    const t = setup([new Error("529 overloaded")]);
    await expect(t.graph.invoke({ messages: ask() })).rejects.toThrow(/529/);
  });
});

describe("routeByIntent", () => {
  it("cubre las cinco intenciones y usa la rama de solo lectura si falta", () => {
    const at = (intent: Intent | undefined) => routeByIntent(makeState([], { intent }));
    expect(INTENTS.map(at)).toEqual(["agent", "action_agent", "plan_report", "chat", "clarify"]);
    expect(at(undefined)).toBe("agent");
  });
});

describe("tope de pasos (CA10)", () => {
  it("el tope es de 12", () => {
    expect(AGENT_RECURSION_LIMIT).toBe(12);
  });

  it("permite una cadena de 4 rondas de herramientas más la respuesta final", async () => {
    const replies = [toolCall("1"), toolCall("2"), toolCall("3"), toolCall("4"), new AIMessage("Listo.")];
    const t = setup([route("query")], replies);
    const { path, state } = await runPath(t.graph, ask());
    expect(path.filter((n) => n === "tools")).toHaveLength(4);
    expect(state.messages.at(-1)?.text).toBe("Listo.");
  });

  it("corta con GraphRecursionError un ciclo que no termina", async () => {
    const t = setup([route("query")], (n) => toolCall(`loop${n}`));
    await expect(runPath(t.graph, ask())).rejects.toMatchObject({ name: "GraphRecursionError" });
    expect(t.agent.calls).toBeLessThanOrEqual(AGENT_RECURSION_LIMIT);
  });

  it("también corta una cadena de 6 rondas, que sí excede el tope", async () => {
    const replies = [1, 2, 3, 4, 5, 6].map((i) => toolCall(String(i))).concat(new AIMessage("tarde"));
    const t = setup([route("query")], replies);
    await expect(runPath(t.graph, ask())).rejects.toMatchObject({ name: "GraphRecursionError" });
  });
});
