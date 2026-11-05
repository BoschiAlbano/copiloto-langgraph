import type { BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { isActionName } from "../tools/actions/schemas.js";
import type { Approval, PendingAction } from "../graph/approval.js";
import { makeActionAgentNode } from "../graph/nodes/action-agent.js";
import { makeApprovalNode, makeExecuteActionNode, makeProposeActionNode, type ActionRunner } from "../graph/nodes/actions.js";
import type { AgentModel } from "../graph/nodes/agent.js";
import { detectLoop, makeRecoverNode } from "../graph/nodes/recover.js";
import type { Plan } from "../graph/plan.js";
import { ActionState } from "../graph/state.js";
import { lastToolCalls } from "./query.js";

/**
 * Arista condicional del agente de acciones:
 *  - nada pedido → termina (respondió o hizo una pregunta);
 *  - alguna ACCIÓN pedida → `propose_action` (aunque venga mezclada: ahí se rechaza la mezcla);
 *  - solo consultas → `tools`.
 */
export function routeAfterActionAgent(state: { messages: BaseMessage[]; plan?: Plan }): "tools" | "propose_action" | "recover" | typeof END {
  const calls = lastToolCalls(state);
  if (calls.length === 0) return END;
  // Fase 10: el tope de rondas y las consultas repetidas valen también acá (una propuesta cuenta como una ronda).
  if (detectLoop(state)) return "recover";
  return calls.some((c) => isActionName(c.name)) ? "propose_action" : "tools";
}

/** Una propuesta válida espera la decisión; una inválida vuelve al modelo como error de herramienta. */
export function routeAfterPropose(state: { pendingAction?: PendingAction | null }): "await_approval" | "action_agent" {
  return state.pendingAction ? "await_approval" : "action_agent";
}

/**
 * Solo una aprobación o un rechazo pasan a `execute_action`. Una decisión que no se pudo usar (formato o edición
 * inválida) o una edición válida (`revised`: hay que aprobar lo editado) vuelven a preguntar.
 */
export function routeAfterApproval(state: { approval?: Approval | null }): "execute_action" | "await_approval" {
  const decision = state.approval?.decision;
  return decision === "approved" || decision === "rejected" ? "execute_action" : "await_approval";
}

export interface ActionGraphOptions {
  /** Con las herramientas de consulta y las DEFINICIONES de las acciones enlazadas (no se ejecutan como herramientas). */
  model: AgentModel;
  /** Las herramientas de CONSULTA, para su propio `tools`. Nunca incluye acciones. */
  tools: StructuredToolInterface[];
  /** Prepara y ejecuta las acciones aprobadas. */
  actions: ActionRunner;
  now?: () => Date;
  /**
   * Solo para probarlo suelto (las acciones necesitan un checkpointer para pausar). Dentro del grafo principal usa
   * el de ese grafo, y la pausa de acá adentro pausa todo el grafo.
   */
  checkpointer?: BaseCheckpointSaver;
}

/**
 * Agente de acciones (fase 7): el flujo de aprobación de la fase 5 como subgrafo. `pendingAction` y `approval` son
 * PRIVADOS: el grafo principal no los ve. Tiene su propio ToolNode de consultas, así que vuelve siempre a
 * `action_agent` (antes, un `tools` compartido tenía que mirar `intent` para saber a quién volver).
 *
 *   START → action_agent ─┬─ nada → END
 *              ▲          ├─ consultas → tools ─────────────────┐
 *              │          └─ una acción → propose_action ─┬─ inválida ─┤
 *              │                                          └─ válida → await_approval ⟲ (interrupt)
 *              └───────────────────── execute_action ◀──────────────────┘
 */
export function buildActionGraph({ model, tools, actions, now, checkpointer }: ActionGraphOptions) {
  return (
    new StateGraph(ActionState)
      .addNode("action_agent", makeActionAgentNode(model, { now }))
      // Solo conoce herramientas de consulta: una acción que llegara acá daría "la herramienta no existe".
      .addNode("tools", new ToolNode(tools, { handleToolErrors: true }))
      .addNode("propose_action", makeProposeActionNode(actions, { now }))
      // Se llama await_approval y no approval: LangGraph no admite un nodo con el nombre de un campo del estado.
      .addNode("await_approval", makeApprovalNode(actions, { now }))
      .addNode("execute_action", makeExecuteActionNode(actions, { now }))
      .addNode("recover", makeRecoverNode("action"))
      .addEdge(START, "action_agent")
      .addConditionalEdges("action_agent", routeAfterActionAgent, ["tools", "propose_action", "recover", END])
      .addEdge("recover", END)
      .addEdge("tools", "action_agent")
      .addConditionalEdges("propose_action", routeAfterPropose, ["await_approval", "action_agent"])
      .addConditionalEdges("await_approval", routeAfterApproval, ["execute_action", "await_approval"])
      .addEdge("execute_action", "action_agent")
      .compile({ checkpointer })
  );
}
