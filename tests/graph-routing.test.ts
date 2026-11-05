import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { buildGraph } from "../src/graph/index.js";
import { INTENTS, type Intent } from "../src/graph/intents.js";
import { AGENT_RECURSION_LIMIT } from "../src/graph/limits.js";
import type { AgentModel } from "../src/graph/nodes/agent.js";
import type { RouterModel } from "../src/graph/nodes/router.js";
import { AGENT_NODES } from "../src/graph/plan.js";
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
/** Una ronda distinta de las demás (otros argumentos; la herramienta los ignora). Repetir lo mismo es un loop (fase 10). */
const round = (id: string) => new AIMessage({ content: "", tool_calls: [{ id, name: "getStock", args: { ronda: id }, type: "tool_call" }] });

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

/**
 * Corre un turno y devuelve los nodos recorridos, en orden, y el estado final. Con `subgraphs: true` el stream trae
 * también los pasos de adentro de cada subgrafo, con su espacio de nombres: se anotan como `subgrafo/nodo` (en
 * `path`, intercalados con los del grafo principal, y aparte en `inner`).
 */
async function runPath(graph: ReturnType<typeof setup>["graph"], messages: BaseMessage[], recursionLimit = AGENT_RECURSION_LIMIT) {
  const path: string[] = [];
  const inner: string[] = [];
  let state: Awaited<ReturnType<typeof graph.invoke>> | undefined;
  const stream = await graph.stream({ messages }, { streamMode: ["updates", "values"], recursionLimit, subgraphs: true });
  for await (const [namespace, mode, chunk] of stream as AsyncIterable<[string[], string, unknown]>) {
    const prefix = namespace.length ? `${namespace[0]!.split(":")[0]}/` : "";
    if (mode === "updates") {
      for (const node of Object.keys(chunk as object)) {
        path.push(prefix + node);
        if (prefix) inner.push(prefix + node);
      }
    } else if (!prefix) state = chunk as typeof state;
  }
  return { path, inner, state: state! };
}

/** El camino del grafo principal, sin los pasos de adentro de los subgrafos. */
const outer = (path: string[]) => path.filter((n) => !n.includes("/"));

const ask = (text = "hola") => [new HumanMessage(text)];

describe("cada intención llega a su agente (CA5), pasando por el supervisor (fase 7)", () => {
  // Desde la fase 7 el grafo principal es router → supervisor → agente → supervisor; adentro de cada subgrafo
  // corren los mismos nodos que antes (se comprueban en `inner`).
  const expectedInner: Record<Intent, string[]> = {
    query: ["query_graph/agent"],
    chat: [],
    action: ["action_graph/action_agent"],
    report: ["report_graph/plan_report", "report_graph/report_appointments", "report_graph/report_sales", "report_graph/report_stock", "report_graph/compose_report"],
    unclear: [],
    memory: [], // fase 8: un nodo simple (sin Store en este test responde que la memoria no está disponible)
  };

  for (const intent of INTENTS) {
    const agent = AGENT_NODES[intent];
    it(`${intent} → router → supervisor → ${agent} → supervisor`, async () => {
      const t = setup([route(intent)]);
      const { path, inner, state } = await runPath(t.graph, ask());
      expect(outer(path)).toEqual(["load_memory", "router", "supervisor", agent, "supervisor"]);
      // Las tres secciones del reporte corren en el mismo paso: su orden entre sí no está definido, por eso se ordenan.
      const sections = inner.filter((n) => n.includes("/report_")).sort();
      const comparable = intent === "report" ? [inner[0]!, ...sections, inner.at(-1)!] : inner;
      expect(comparable).toEqual(expectedInner[intent]);
      expect(state.intent).toBe(intent);
      expect(state.intentReason).toBe(`motivo ${intent}`);
      expect(state.activeAgent).toBeNull(); // terminó el turno: ningún agente activo
      expect(state.plan?.tasks.map((x) => x.status)).toEqual(["done"]);
      expect(state.messages.at(-1)).toBeInstanceOf(AIMessage);
    });
  }

  it("la consulta con herramientas recorre agent → tools → agent dentro del subgrafo de consultas", async () => {
    const t = setup([route("query")], [toolCall("1"), new AIMessage("Hay 2 productos bajos.")]);
    const { path, state } = await runPath(t.graph, ask("¿stock bajo?"));
    expect(path).toEqual(["load_memory", "router", "supervisor", "query_graph/agent", "query_graph/tools", "query_graph/agent", "query_graph", "supervisor"]);
    expect(state.messages.at(-1)?.text).toBe("Hay 2 productos bajos.");
  });
});

describe("solo se usa el modelo de la rama elegida", () => {
  it("charla: no corre el nodo tools ni el agente (CA4)", async () => {
    toolRuns = 0;
    const t = setup([route("chat")]);
    const { path } = await runPath(t.graph, ask("Hola, buen día."));
    expect(path.some((n) => n.endsWith("tools"))).toBe(false);
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
    const { state, inner } = await runPath(t.graph, ask("armame el resumen"));
    expect(inner[0]).toBe("report_graph/plan_report");
    expect(inner.at(-1)).toBe("report_graph/compose_report");
    expect(state.messages.at(-1)?.text).toContain("Reporte ·");
    expect([t.router.calls, t.reportPlan.calls, t.report.calls]).toEqual([1, 1, 1]);
    expect([t.agent.calls, t.action.calls, t.chat.calls, t.clarify.calls]).toEqual([0, 0, 0, 0]);
  });

  it("acción: usa solo el agente de acciones (y no el de consultas), y una respuesta sin llamadas termina el turno", async () => {
    const t = setup([route("action")]);
    const { state, inner } = await runPath(t.graph, ask("pedido de cambio"));
    expect(inner).toEqual(["action_graph/action_agent"]);
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
    expect(outer(turn2.path)).toEqual(["load_memory", "router", "supervisor", "chat", "supervisor"]);
  });
});

describe("fallas del router (CA7)", () => {
  it("una salida inválida sigue por query y avisa", async () => {
    const t = setup([{ parsed: null }, { parsed: null }]);
    const { path, state } = await runPath(t.graph, ask());
    expect(outer(path)).toEqual(["load_memory", "router", "supervisor", "query_graph", "supervisor"]);
    expect(state.intent).toBe("query");
    expect(t.warn).toHaveBeenCalledTimes(2); // fase 10: el segundo intento y el respaldo
  });

  it("un error de la API llega a quien invoca el grafo", async () => {
    const t = setup([new Error("529 overloaded")]);
    await expect(t.graph.invoke({ messages: ask() })).rejects.toThrow(/529/);
  });
});

describe("AGENT_NODES (antes routeByIntent)", () => {
  it("cubre las seis intenciones", () => {
    expect(INTENTS.map((i) => AGENT_NODES[i])).toEqual(["query_graph", "action_graph", "report_graph", "chat", "clarify", "memory"]);
  });
});

describe("tope de pasos (CA10)", () => {
  it("el tope es de 12", () => {
    expect(AGENT_RECURSION_LIMIT).toBe(12);
  });

  it("permite una cadena de 4 rondas de herramientas más la respuesta final", async () => {
    const replies = [round("1"), round("2"), round("3"), round("4"), new AIMessage("Listo.")];
    const t = setup([route("query")], replies);
    const { path, state } = await runPath(t.graph, ask());
    expect(path.filter((n) => n === "query_graph/tools")).toHaveLength(4);
    expect(state.messages.at(-1)?.text).toBe("Listo.");
  });

  it("fase 10: un ciclo que no termina (siempre la misma consulta) se corta en recover, sin llegar al tope de pasos", async () => {
    const t = setup([route("query")], (n) => toolCall(`loop${n}`));
    const { path, state } = await runPath(t.graph, ask());
    expect(path).toContain("query_graph/recover");
    expect(state.messages.at(-1)?.text).toMatch(/^No pude terminar la consulta: estaba repitiendo/);
    expect(t.agent.calls).toBe(2); // la segunda llamada idéntica ya es un loop
    expect(t.agent.calls).toBeLessThan(AGENT_RECURSION_LIMIT);
  });

  it("fase 10: una cadena de 6 rondas distintas pasa a recover en la quinta (tope de 4)", async () => {
    const replies = [1, 2, 3, 4, 5, 6].map((i) => round(String(i))).concat(new AIMessage("tarde"));
    const t = setup([route("query")], replies);
    const { path, state } = await runPath(t.graph, ask());
    expect(path.filter((n) => n === "query_graph/tools")).toHaveLength(4);
    expect(state.messages.at(-1)?.text).toMatch(/^No pude terminar la consulta: hice 4 rondas/);
    expect(t.agent.calls).toBe(5);
  });
});
