import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { Agent } from "./create-agent.js";
import { AGENT_RECURSION_LIMIT } from "./limits.js";
import { summarizeTurn, type TurnSummary } from "./usage.js";

export interface TurnResult {
  /** Historial completo después del turno: hay que pasarlo de nuevo en el próximo (hasta la fase 4). */
  messages: BaseMessage[];
  reply: string;
  summary: TurnSummary;
}

/** Un turno de conversación: mensaje de la persona → respuesta final, con el resumen de uso. */
export async function runTurn(agent: Agent, history: BaseMessage[], input: string): Promise<TurnResult> {
  const state = await agent.graph.invoke(
    { messages: [...history, new HumanMessage(input)] },
    { recursionLimit: AGENT_RECURSION_LIMIT },
  );
  const messages: BaseMessage[] = state.messages;
  const newMessages = messages.slice(history.length + 1);
  return { messages, reply: messages.at(-1)?.text ?? "", summary: summarizeTurn(newMessages) };
}
