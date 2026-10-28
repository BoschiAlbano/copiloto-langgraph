import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { Intent } from "./intents.js";
import { makeAgentNode, type AgentModel } from "./nodes/agent.js";
import { makeChatNode } from "./nodes/chat.js";
import { makeClarifyNode } from "./nodes/clarify.js";
import { makeRouterNode, type RouterModel } from "./nodes/router.js";
import { actionStubNode, reportStubNode } from "./nodes/stubs.js";
import { AgentState, type AgentStateType } from "./state.js";

/** Nodo al que va cada intención. Al ser un Record<Intent, …>, TypeScript exige cubrirlas todas. */
const ROUTES: Record<Intent, "agent" | "chat" | "action_stub" | "report_stub" | "clarify"> = {
  query: "agent",
  chat: "chat",
  action: "action_stub",
  report: "report_stub",
  unclear: "clarify",
};

/** Arista condicional del router: lee `intent` y devuelve el nombre del próximo nodo. */
export function routeByIntent(state: AgentStateType) {
  // Sin intención (no debería pasar) se usa la rama de solo lectura.
  return state.intent ? ROUTES[state.intent] : "agent";
}

/** Arista condicional del agente: si el modelo pidió herramientas, vamos a `tools`; si no, terminamos. */
export function routeAfterAgent(state: AgentStateType): "tools" | typeof END {
  const last: BaseMessage | undefined = state.messages.at(-1);
  return last && AIMessage.isInstance(last) && last.tool_calls?.length ? "tools" : END;
}

export interface BuildGraphOptions {
  models: {
    /** Clasifica el pedido (salida estructurada). */
    router: RouterModel;
    /** Con las herramientas ya enlazadas (bindTools). */
    agent: AgentModel;
    /** SIN herramientas. */
    chat: AgentModel;
    /** SIN herramientas: escribe la pregunta de aclaración. */
    clarify: AgentModel;
  };
  /** Las mismas herramientas del agente, para que `tools` pueda ejecutarlas. */
  tools: StructuredToolInterface[];
  /** Reloj inyectable para los tests. */
  now?: () => Date;
  /** Avisos de quien opera el sistema (por ejemplo, salida inválida del router). */
  warn?: (message: string) => void;
}

/**
 *                       ┌─ query   → agent ⇄ tools → END
 *  START → router ──────┼─ chat    → chat          → END
 *                       ├─ action  → action_stub   → END
 *                       ├─ report  → report_stub   → END
 *                       └─ unclear → clarify       → END
 */
export function buildGraph({ models, tools, now, warn }: BuildGraphOptions) {
  return (
    new StateGraph(AgentState)
      .addNode("router", makeRouterNode(models.router, { warn }))
      .addNode("agent", makeAgentNode(models.agent, { now }))
      // handleToolErrors: una excepción de la herramienta vuelve al modelo como mensaje de error.
      .addNode("tools", new ToolNode(tools, { handleToolErrors: true }))
      .addNode("chat", makeChatNode(models.chat))
      .addNode("action_stub", actionStubNode)
      .addNode("report_stub", reportStubNode)
      .addNode("clarify", makeClarifyNode(models.clarify))
      .addEdge(START, "router")
      .addConditionalEdges("router", routeByIntent, ["agent", "chat", "action_stub", "report_stub", "clarify"])
      .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
      .addEdge("tools", "agent")
      .addEdge("chat", END)
      .addEdge("action_stub", END)
      .addEdge("report_stub", END)
      .addEdge("clarify", END)
      .compile()
  );
}
