import { describe, expect, it } from "vitest";
import { buildActionGraph } from "../src/agents/action.js";
import { buildQueryGraph } from "../src/agents/query.js";
import { buildReportGraph } from "../src/agents/report.js";
import { scriptedModel } from "./helpers/models.js";
import { buildTestGraph, unexpectedActions, unexpectedPlan, unexpectedSections } from "./helpers/graph.js";

// La forma de cada grafo compilado, tal como la dibuja `specs/mapa-del-grafo.md` (fase 7).

const shape = async (graph: { getGraphAsync(): Promise<{ nodes: Record<string, unknown>; edges: { source: string; target: string; conditional?: boolean }[] }> }) => {
  const drawable = await graph.getGraphAsync();
  const nodes = Object.keys(drawable.nodes).filter((n) => !n.startsWith("__")).sort();
  const edges = drawable.edges.map((e) => `${e.source}${e.conditional ? " -?-> " : " --> "}${e.target}`).sort();
  return { nodes, edges };
};

const model = scriptedModel([]).model;

describe("forma de los grafos (fases 7 y 8)", () => {
  it("el principal: 9 nodos y 16 conexiones; empieza en load_memory y el supervisor sale por Command hacia los 6 agentes y END", async () => {
    const { nodes, edges } = await shape(buildTestGraph({ model, tools: [] }));
    expect(nodes).toEqual(["action_graph", "chat", "clarify", "load_memory", "memory", "query_graph", "report_graph", "router", "supervisor"]);
    expect(edges).toEqual([
      "__start__ --> load_memory",
      "action_graph --> supervisor",
      "chat --> supervisor",
      "clarify --> supervisor",
      "load_memory --> router",
      "memory --> supervisor",
      "query_graph --> supervisor",
      "report_graph --> supervisor",
      "router --> supervisor",
      "supervisor -?-> __end__",
      "supervisor -?-> action_graph",
      "supervisor -?-> chat",
      "supervisor -?-> clarify",
      "supervisor -?-> memory",
      "supervisor -?-> query_graph",
      "supervisor -?-> report_graph",
    ]);
  });

  it("consultas: agent ⇄ tools (4 conexiones)", async () => {
    const { nodes, edges } = await shape(buildQueryGraph({ model, tools: [] }));
    expect(nodes).toEqual(["agent", "tools"]);
    expect(edges).toEqual(["__start__ --> agent", "agent -?-> __end__", "agent -?-> tools", "tools --> agent"]);
  });

  it("acciones: 5 nodos y 10 conexiones", async () => {
    const { nodes, edges } = await shape(buildActionGraph({ model, tools: [], actions: unexpectedActions }));
    expect(nodes).toEqual(["action_agent", "await_approval", "execute_action", "propose_action", "tools"]);
    expect(edges).toEqual([
      "__start__ --> action_agent",
      "action_agent -?-> __end__",
      "action_agent -?-> propose_action",
      "action_agent -?-> tools",
      "await_approval -?-> await_approval",
      "await_approval -?-> execute_action",
      "execute_action --> action_agent",
      "propose_action -?-> action_agent",
      "propose_action -?-> await_approval",
      "tools --> action_agent",
    ]);
  });

  it("reportes: 5 nodos y 8 conexiones (3 Send de fan-out y 3 de fan-in)", async () => {
    const { nodes, edges } = await shape(buildReportGraph({ plan: unexpectedPlan, reading: model, sections: unexpectedSections }));
    expect(nodes).toEqual(["compose_report", "plan_report", "report_appointments", "report_sales", "report_stock"]);
    expect(edges).toHaveLength(8);
    expect(edges.filter((e) => e.startsWith("plan_report -?->"))).toHaveLength(3);
    expect(edges.filter((e) => e.endsWith("--> compose_report"))).toHaveLength(3);
  });
});
