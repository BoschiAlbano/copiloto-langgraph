import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { isActionName } from "../tools/actions/schemas.js";
import type { Intent } from "./intents.js";
import { makeActionAgentNode } from "./nodes/action-agent.js";
import { makeApprovalNode, makeExecuteActionNode, makeProposeActionNode, type ActionRunner } from "./nodes/actions.js";
import { makeAgentNode, type AgentModel } from "./nodes/agent.js";
import { makeChatNode } from "./nodes/chat.js";
import { makeClarifyNode } from "./nodes/clarify.js";
import { makeRouterNode, type RouterModel } from "./nodes/router.js";
import { reportStubNode } from "./nodes/stubs.js";
import { AgentState, type AgentStateType } from "./state.js";

/** Nodo al que va cada intención. Al ser un Record<Intent, …>, TypeScript exige cubrirlas todas. */
const ROUTES: Record<Intent, "agent" | "chat" | "action_agent" | "report_stub" | "clarify"> = {
  query: "agent",
  chat: "chat",
  action: "action_agent",
  report: "report_stub",
  unclear: "clarify",
};

/** Arista condicional del router: lee `intent` y devuelve el nombre del próximo nodo. */
export function routeByIntent(state: AgentStateType) {
  // Sin intención (no debería pasar) se usa la rama de solo lectura.
  return state.intent ? ROUTES[state.intent] : "agent";
}

const lastToolCalls = (state: AgentStateType) => {
  const last: BaseMessage | undefined = state.messages.at(-1);
  return last && AIMessage.isInstance(last) ? (last.tool_calls ?? []) : [];
};

/** Arista condicional del agente de consultas: si el modelo pidió herramientas, vamos a `tools`; si no, terminamos. */
export function routeAfterAgent(state: AgentStateType): "tools" | typeof END {
  return lastToolCalls(state).length ? "tools" : END;
}

/**
 * Arista condicional del agente de acciones:
 *  - nada pedido → termina (respondió o hizo una pregunta);
 *  - alguna ACCIÓN pedida → `propose_action` (aunque venga mezclada: ahí se rechaza la mezcla);
 *  - solo consultas → `tools`.
 */
export function routeAfterActionAgent(state: AgentStateType): "tools" | "propose_action" | typeof END {
  const calls = lastToolCalls(state);
  if (calls.length === 0) return END;
  return calls.some((c) => isActionName(c.name)) ? "propose_action" : "tools";
}

/** Después de las consultas se vuelve al agente que las pidió: el de acciones si el pedido es una acción. */
export function routeAfterTools(state: AgentStateType): "agent" | "action_agent" {
  return state.intent === "action" ? "action_agent" : "agent";
}

/** Una propuesta válida espera la decisión; una inválida vuelve al modelo como error de herramienta. */
export function routeAfterPropose(state: AgentStateType): "await_approval" | "action_agent" {
  return state.pendingAction ? "await_approval" : "action_agent";
}

/** Una decisión que no se pudo usar (formato o edición inválida) vuelve a preguntar; si no, se ejecuta. */
export function routeAfterApproval(state: AgentStateType): "execute_action" | "await_approval" {
  return state.approval?.decision === "invalid" ? "await_approval" : "execute_action";
}

export interface BuildGraphOptions {
  models: {
    /** Clasifica el pedido (salida estructurada). */
    router: RouterModel;
    /** Con las herramientas de consulta ya enlazadas (bindTools). */
    agent: AgentModel;
    /** Con las herramientas de consulta y las DEFINICIONES de las acciones enlazadas (no se ejecutan como herramientas). */
    action: AgentModel;
    /** SIN herramientas. */
    chat: AgentModel;
    /** SIN herramientas: escribe la pregunta de aclaración. */
    clarify: AgentModel;
  };
  /** Las herramientas de CONSULTA, para que `tools` pueda ejecutarlas. Nunca incluye acciones. */
  tools: StructuredToolInterface[];
  /** Prepara y ejecuta las acciones aprobadas. */
  actions: ActionRunner;
  /** Reloj inyectable para los tests. */
  now?: () => Date;
  /** Avisos de quien opera el sistema (por ejemplo, salida inválida del router). */
  warn?: (message: string) => void;
  /** Guarda el estado después de cada paso, por thread_id. Las acciones lo necesitan: sin él no se puede pausar. */
  checkpointer?: BaseCheckpointSaver;
}

/**
 *                       ┌─ query   → agent ⇄ tools → END
 *                       ├─ chat    → chat          → END
 *  START → router ──────┼─ report  → report_stub   → END
 *                       ├─ unclear → clarify       → END
 *                       └─ action  → action_agent ─┬─ nada → END
 *                              ▲        │          ├─ consultas → tools ─┐ (vuelve a action_agent)
 *                              │        │          └─ una acción → propose_action ─┬─ inválida → action_agent
 *                              │        │                                          └─ válida → await_approval ⟲ (interrupt)
 *                              └────────┴──────────────────── execute_action ◀──────────────────┘
 */
export function buildGraph({ models, tools, actions, now, warn, checkpointer }: BuildGraphOptions) {
  return (
    new StateGraph(AgentState)
      .addNode("router", makeRouterNode(models.router, { warn }))
      .addNode("agent", makeAgentNode(models.agent, { now }))
      // handleToolErrors: una excepción de la herramienta vuelve al modelo como mensaje de error.
      // Es el ÚNICO ToolNode y solo conoce herramientas de consulta: una acción pedida acá da "no existe".
      .addNode("tools", new ToolNode(tools, { handleToolErrors: true }))
      .addNode("chat", makeChatNode(models.chat))
      .addNode("report_stub", reportStubNode)
      .addNode("clarify", makeClarifyNode(models.clarify))
      .addNode("action_agent", makeActionAgentNode(models.action, { now }))
      .addNode("propose_action", makeProposeActionNode(actions, { now }))
      // Se llama await_approval y no approval: LangGraph no admite un nodo con el nombre de un campo del estado.
      .addNode("await_approval", makeApprovalNode(actions, { now }))
      .addNode("execute_action", makeExecuteActionNode(actions, { now }))
      .addEdge(START, "router")
      .addConditionalEdges("router", routeByIntent, ["agent", "chat", "action_agent", "report_stub", "clarify"])
      .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
      .addConditionalEdges("tools", routeAfterTools, ["agent", "action_agent"])
      .addConditionalEdges("action_agent", routeAfterActionAgent, ["tools", "propose_action", END])
      .addConditionalEdges("propose_action", routeAfterPropose, ["await_approval", "action_agent"])
      .addConditionalEdges("await_approval", routeAfterApproval, ["execute_action", "await_approval"])
      .addEdge("execute_action", "action_agent")
      .addEdge("chat", END)
      .addEdge("report_stub", END)
      .addEdge("clarify", END)
      .compile({ checkpointer })
  );
}
