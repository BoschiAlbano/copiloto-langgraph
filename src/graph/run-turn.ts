import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { Agent } from "./create-agent.js";
import type { Intent } from "./intents.js";
import { AGENT_RECURSION_LIMIT } from "./limits.js";
import { summarizeTurn, type TurnSummary } from "./usage.js";
import { UsageTracker } from "./usage-tracker.js";

export interface TurnResult {
  /** Historial completo después del turno: hay que pasarlo de nuevo en el próximo (hasta la fase 4). */
  messages: BaseMessage[];
  reply: string;
  /** Ruta que eligió el router y por qué. */
  route: { intent?: Intent; reason?: string };
  summary: TurnSummary;
}

/** Un turno de conversación: mensaje de la persona → respuesta final, con la ruta y el uso. */
export async function runTurn(agent: Agent, history: BaseMessage[], input: string): Promise<TurnResult> {
  const tracker = new UsageTracker();
  const state = await agent.graph.invoke(
    { messages: [...history, new HumanMessage(input)] },
    { recursionLimit: AGENT_RECURSION_LIMIT, callbacks: [tracker] },
  );
  const messages: BaseMessage[] = state.messages;
  const newMessages = messages.slice(history.length + 1);
  return {
    messages,
    reply: messages.at(-1)?.text ?? "",
    route: { intent: state.intent, reason: state.intentReason },
    summary: summarizeTurn(newMessages, tracker.usage()),
  };
}
