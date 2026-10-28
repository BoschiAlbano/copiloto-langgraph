import { AIMessage, type BaseMessage } from "@langchain/core/messages";

export interface TurnSummary {
  /** Llamadas a Claude en el turno: una por cada paso del agente. */
  modelCalls: number;
  toolCalls: { name: string; args: Record<string, unknown> }[];
  inputTokens: number;
  outputTokens: number;
}

/** Resume los mensajes que se agregaron al historial durante un turno. */
export function summarizeTurn(newMessages: BaseMessage[]): TurnSummary {
  const summary: TurnSummary = { modelCalls: 0, toolCalls: [], inputTokens: 0, outputTokens: 0 };
  for (const message of newMessages) {
    if (!AIMessage.isInstance(message)) continue;
    summary.modelCalls += 1;
    summary.inputTokens += message.usage_metadata?.input_tokens ?? 0;
    summary.outputTokens += message.usage_metadata?.output_tokens ?? 0;
    for (const call of message.tool_calls ?? []) summary.toolCalls.push({ name: call.name, args: call.args });
  }
  return summary;
}
