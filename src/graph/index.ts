import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { makeAgentNode, type AgentModel } from "./nodes/agent.js";
import { AgentState, type AgentStateType } from "./state.js";

/** Arista condicional: si el modelo pidió herramientas, vamos a `tools`; si no, terminamos. */
export function routeAfterAgent(state: AgentStateType): "tools" | typeof END {
  const last: BaseMessage | undefined = state.messages.at(-1);
  return last && AIMessage.isInstance(last) && last.tool_calls?.length ? "tools" : END;
}

export interface BuildGraphOptions {
  /** Modelo con las herramientas ya enlazadas. */
  model: AgentModel;
  /** Las mismas herramientas, para que `tools` pueda ejecutarlas. */
  tools: StructuredToolInterface[];
  /** Reloj inyectable para los tests. */
  now?: () => Date;
}

/**
 *            ┌───────────── resultados ─────────────┐
 *            ▼                                      │
 *  START → agent ──(¿pidió herramientas?)── sí → tools
 *                 └─ no → END
 */
export function buildGraph({ model, tools, now }: BuildGraphOptions) {
  return new StateGraph(AgentState)
    .addNode("agent", makeAgentNode(model, { now }))
    // handleToolErrors: una excepción de la herramienta vuelve al modelo como mensaje de error.
    .addNode("tools", new ToolNode(tools, { handleToolErrors: true }))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
    .addEdge("tools", "agent")
    .compile();
}
