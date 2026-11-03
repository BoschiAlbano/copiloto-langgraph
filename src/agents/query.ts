import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { makeAgentNode, type AgentModel } from "../graph/nodes/agent.js";
import { QueryState } from "../graph/state.js";

/** Las llamadas a herramientas del último mensaje, si es de la IA. */
export const lastToolCalls = (state: { messages: BaseMessage[] }) => {
  const last = state.messages.at(-1);
  return last && AIMessage.isInstance(last) ? (last.tool_calls ?? []) : [];
};

/** Arista condicional del agente de consultas: si el modelo pidió herramientas, vamos a `tools`; si no, terminamos. */
export function routeAfterAgent(state: { messages: BaseMessage[] }): "tools" | typeof END {
  return lastToolCalls(state).length ? "tools" : END;
}

export interface QueryGraphOptions {
  /** Con las herramientas de consulta ya enlazadas (bindTools). */
  model: AgentModel;
  /** Las herramientas de CONSULTA. Nunca incluye acciones: una acción pedida acá da "la herramienta no existe". */
  tools: StructuredToolInterface[];
  now?: () => Date;
  /** Solo para probarlo suelto. Dentro del grafo principal usa el checkpointer de ese grafo. */
  checkpointer?: BaseCheckpointSaver;
}

/**
 * Agente de consultas (fase 7): el ciclo agent ⇄ tools de la fase 2 como subgrafo, con su PROPIO ToolNode. Ya no
 * comparte `tools` con el agente de acciones, así que la vuelta es siempre a `agent` y no hace falta mirar `intent`.
 *
 *   START → agent ─┬─ pidió herramientas → tools → agent
 *                  └─ respondió → END
 */
export function buildQueryGraph({ model, tools, now, checkpointer }: QueryGraphOptions) {
  return (
    new StateGraph(QueryState)
      .addNode("agent", makeAgentNode(model, { now }))
      // handleToolErrors: una excepción de la herramienta vuelve al modelo como mensaje de error.
      .addNode("tools", new ToolNode(tools, { handleToolErrors: true }))
      .addEdge(START, "agent")
      .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
      .addEdge("tools", "agent")
      .compile({ checkpointer })
  );
}
