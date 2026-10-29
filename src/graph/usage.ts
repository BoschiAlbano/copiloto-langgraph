import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { isActionName } from "../tools/actions/schemas.js";
import { totalUsage, type ModelUsage } from "./usage-tracker.js";

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
  for (const message of newMessages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) toolCalls.push({ name: call.name, args: call.args });
    } else if (ToolMessage.isInstance(message) && message.name && isActionName(message.name)) {
      actions.push({ tool: message.name, ok: message.status !== "error", message: message.text });
    }
  }
  const total = totalUsage(usage);
  return { modelCalls: total.calls, toolCalls, actions, inputTokens: total.inputTokens, outputTokens: total.outputTokens, usage };
}
