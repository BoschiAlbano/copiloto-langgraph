import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { isActionName } from "../tools/actions/schemas.js";
import { AGENT_NODE_NAMES, AGENT_NODES, type AgentNode, type Plan } from "./plan.js";
import { mergeUsage, totalUsage, type ModelUsage, type RunUsage } from "./usage-tracker.js";

/** Resultado de una acción, tal como lo armó el código al decidir la persona (no lo que el modelo contó después). */
export interface ActionResult {
  tool: string;
  ok: boolean;
  message: string;
}

export interface TurnSummary {
  /** Llamadas a Claude en el turno, de todos los nodos (router, aclaración, charla, agente). */
  modelCalls: number;
  toolCalls: { name: string; args: Record<string, unknown> }[];
  /** Acciones decididas en el turno (ejecutadas, rechazadas o fallidas), con el texto del código. */
  actions: ActionResult[];
  /** Herramientas de consulta que terminaron con error en el turno (fase 10: después de sus reintentos). */
  failedTools: string[];
  inputTokens: number;
  outputTokens: number;
  /** Desglose por modelo, tomado del UsageTracker. */
  usage: ModelUsage[];
}

/**
 * Resume un turno. Las herramientas salen de los mensajes nuevos del historial; los tokens
 * vienen del UsageTracker porque no todas las llamadas dejan su uso en `messages`.
 */
export function summarizeTurn(newMessages: BaseMessage[], usage: ModelUsage[]): TurnSummary {
  const toolCalls: TurnSummary["toolCalls"] = [];
  const actions: ActionResult[] = [];
  const failedTools: string[] = [];
  for (const message of newMessages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) toolCalls.push({ name: call.name, args: call.args });
    } else if (ToolMessage.isInstance(message) && message.name && isActionName(message.name)) {
      actions.push({ tool: message.name, ok: message.status !== "error", message: message.text });
    } else if (ToolMessage.isInstance(message) && message.status === "error" && !message.additional_kwargs?.skipped) {
      failedTools.push(message.name ?? "herramienta");
    }
  }
  const total = totalUsage(usage);
  return { modelCalls: total.calls, toolCalls, actions, failedTools, inputTokens: total.inputTokens, outputTokens: total.outputTokens, usage };
}

/** Un agente que intervino en el turno (fase 7), con lo que hizo y lo que costó. */
export interface AgentStep {
  agent: AgentNode;
  /** Las herramientas que pidió en esta parte del turno, en orden (incluida la acción propuesta). */
  tools: string[];
  /** Sus llamadas al modelo, por modelo. */
  usage: ModelUsage[];
  /** El turno quedó esperando la decisión de la persona sobre la acción de este agente. */
  waiting?: true;
}

const isAgentNode = (node: string): node is AgentNode => (AGENT_NODE_NAMES as string[]).includes(node);

/**
 * Qué agentes intervinieron en una invocación del grafo, en orden. Las llamadas al modelo vienen del UsageTracker
 * (atribuidas por espacio de nombres); las herramientas, de los mensajes de la tarea de cada agente: desde su
 * `startedAt` hasta que arrancó la siguiente, y solo lo nuevo de esta invocación (`already`). La k-ésima corrida de
 * un agente es su k-ésima tarea del plan. Lo que no es un agente (el router) va aparte, como coordinación.
 */
export function agentSteps(input: {
  plan?: Plan;
  messages: BaseMessage[];
  already: number;
  runs: RunUsage[];
  awaiting?: boolean;
}): { agents: AgentStep[]; coordination: ModelUsage[] } {
  const started = (input.plan?.tasks ?? []).filter((t) => t.startedAt !== undefined);
  const seen = new Map<AgentNode, number>();
  const agents: AgentStep[] = [];
  let coordination: ModelUsage[] = [];
  for (const run of input.runs) {
    if (!isAgentNode(run.node)) {
      coordination = mergeUsage(coordination, run.usage);
      continue;
    }
    const k = seen.get(run.node) ?? 0;
    seen.set(run.node, k + 1);
    const task = started.filter((t) => AGENT_NODES[t.intent] === run.node)[k];
    const index = task ? started.indexOf(task) : -1;
    const from = Math.max(task?.startedAt ?? input.already, input.already);
    const to = started[index + 1]?.startedAt ?? input.messages.length;
    const tools = task ? summarizeTurn(input.messages.slice(from, to), []).toolCalls.map((c) => c.name) : [];
    agents.push({ agent: run.node, tools, usage: run.usage, ...(input.awaiting && run.node === "action_graph" && { waiting: true as const }) });
  }
  return { agents, coordination };
}
