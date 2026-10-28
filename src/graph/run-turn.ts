import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { Agent } from "./create-agent.js";
import type { Intent } from "./intents.js";
import { AGENT_RECURSION_LIMIT } from "./limits.js";
import { parseThreadId } from "./thread-id.js";
import { summarizeTurn, type TurnSummary } from "./usage.js";
import { UsageTracker } from "./usage-tracker.js";

export interface TurnResult {
  reply: string;
  /** Ruta que eligió el router y por qué. */
  route: { intent?: Intent; reason?: string };
  summary: TurnSummary;
}

/** Lo mínimo que hace falta del agente: el grafo con checkpointer. Los tests pasan grafos propios. */
export type TurnAgent = Pick<Agent, "graph">;

/** Mensajes del turno: todo lo que sigue al último mensaje de la persona. */
export function messagesOfTurn(messages: BaseMessage[]): BaseMessage[] {
  const lastHuman = messages.findLastIndex((m) => HumanMessage.isInstance(m));
  return messages.slice(lastHuman + 1);
}

async function invokeTurn(agent: TurnAgent, threadId: string, input: { messages: HumanMessage[] } | null) {
  const tracker = new UsageTracker();
  const state = await agent.graph.invoke(input, {
    configurable: { thread_id: parseThreadId(threadId) },
    recursionLimit: AGENT_RECURSION_LIMIT,
    callbacks: [tracker],
  });
  const messages: BaseMessage[] = state.messages;
  return {
    reply: messages.at(-1)?.text ?? "",
    route: { intent: state.intent, reason: state.intentReason },
    summary: summarizeTurn(messagesOfTurn(messages), tracker.usage()),
  } satisfies TurnResult;
}

/**
 * Un turno de conversación: mensaje de la persona → respuesta final, con la ruta y el uso.
 * Se manda solo el mensaje nuevo: el historial lo pone el checkpointer a partir del `threadId`.
 */
export async function runTurn(agent: TurnAgent, threadId: string, input: string): Promise<TurnResult> {
  // Detrás de una llamada a herramienta sin respuesta, un mensaje nuevo rompe la API de Claude.
  const status = await agent.graph.getState({ configurable: { thread_id: parseThreadId(threadId) } });
  if (status.next.length > 0) throw new ThreadPendingError(threadId, status.next);
  return invokeTurn(agent, threadId, { messages: [new HumanMessage(input)] });
}

/** El hilo quedó a medias: hay que reanudarlo con `continueTurn` antes de seguir conversando. */
export class ThreadPendingError extends Error {
  constructor(
    readonly threadId: string,
    readonly next: string[],
  ) {
    super(`El hilo ${threadId} quedó a medias (falta correr: ${next.join(", ")}). Reanudalo antes de mandar otro mensaje.`);
    this.name = "ThreadPendingError";
  }
}

/**
 * Reanuda un turno que quedó a medias desde su último checkpoint. No repite el mensaje de la
 * persona: `invoke(null)` significa "seguí donde quedaste". El uso informado es solo el de esta reanudación.
 */
export function continueTurn(agent: TurnAgent, threadId: string): Promise<TurnResult> {
  return invokeTurn(agent, threadId, null);
}
