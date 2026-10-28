import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { totalUsage, type ModelUsage } from "./usage-tracker.js";

export interface TurnSummary {
  /** Llamadas a Claude en el turno, de todos los nodos (router, aclaración, charla, agente). */
  modelCalls: number;
  toolCalls: { name: string; args: Record<string, unknown> }[];
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
  for (const message of newMessages) {
    if (!AIMessage.isInstance(message)) continue;
    for (const call of message.tool_calls ?? []) toolCalls.push({ name: call.name, args: call.args });
  }
  const total = totalUsage(usage);
  return { modelCalls: total.calls, toolCalls, inputTokens: total.inputTokens, outputTokens: total.outputTokens, usage };
}
