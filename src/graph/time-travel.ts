import { randomUUID } from "node:crypto";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { UiEvent } from "../web/events.js";
import { checkpointIdOf, executedActions, messagesOf, pathTo, readHistory, type HistoryGraph } from "./history.js";
import { streamInvoke, ThreadAwaitingApprovalError, ThreadPendingError, type TurnAgent } from "./run-turn.js";
import { getStatus } from "./threads.js";

export type { HistoryGraph } from "./history.js";

// Viaje en el tiempo (fase 10, R10 a R13): volver a correr un turno desde su inicio, con otro mensaje («editar y volver
// a preguntar») o con el mismo («reintentar»). Las dos cosas son una BIFURCACIÓN de LangGraph: desde el checkpoint en
// que entró ese mensaje, `updateState` con el mensaje (nuevo o el mismo) como si viniera de `__start__`, y `stream(null)`
// sobre esa rama. La rama nueva pasa a ser el estado del hilo; la anterior queda en su historia.

/** El mensaje que se quiere editar o reintentar no está en la conversación actual del hilo. */
export class TurnNotFoundError extends Error {
  constructor(messageId: string) {
    super(`Ese mensaje (${messageId}) no está en la conversación actual del hilo.`);
    this.name = "TurnNotFoundError";
  }
}

const hasMessage = (messages: BaseMessage[], messageId: string) => messages.some((m) => HumanMessage.isInstance(m) && m.id === messageId);

export interface TurnStart {
  /** El checkpoint en que ese mensaje todavía no estaba (donde entró): desde ahí se bifurca. */
  config: RunnableConfig;
  /** Los mensajes del hilo antes de ese turno. */
  before: BaseMessage[];
  /** El mensaje original de la persona. */
  original: HumanMessage;
  /** Los mensajes de la rama actual desde ese turno (incluido), para saber qué se reemplaza. */
  replaced: BaseMessage[];
}

/**
 * El inicio de un turno, buscado por el id del mensaje de la persona en la RAMA ACTUAL del hilo. La historia de
 * LangGraph trae los checkpoints de todas las ramas: se sigue la cadena de padres desde el último (`pathTo`).
 */
export async function findTurnStart(graph: HistoryGraph, threadId: string, messageId: string): Promise<TurnStart> {
  const history = await readHistory(graph, threadId);
  const latest = history.latest;
  if (!latest || !hasMessage(messagesOf(latest), messageId)) throw new TurnNotFoundError(messageId);
  // Hacia atrás por la rama actual: el último checkpoint SIN el mensaje es donde entró (su `input`).
  const current = pathTo(history, checkpointIdOf(latest.config)).findLast((s) => !hasMessage(messagesOf(s), messageId));
  if (!current) throw new TurnNotFoundError(messageId);
  const messages = messagesOf(latest);
  const at = messages.findIndex((m) => m.id === messageId);
  const original = messages[at] as HumanMessage;
  return { config: current.config, before: messagesOf(current), original, replaced: messages.slice(at) };
}

async function* streamBranch(
  agent: TurnAgent & { graph: HistoryGraph },
  threadId: string,
  messageId: string,
  kind: "edit" | "retry",
  text: string | undefined,
  signal?: AbortSignal,
): AsyncGenerator<UiEvent> {
  // Igual que un mensaje nuevo: no con una tarjeta pendiente ni con un turno a medias (R13).
  const status = await getStatus(agent.graph, threadId);
  if (status.awaiting) throw new ThreadAwaitingApprovalError(threadId, status.awaiting);
  if (status.pending) throw new ThreadPendingError(threadId, status.next);

  const start = await findTurnStart(agent.graph, threadId, messageId);
  // Un id nuevo: es otro mensaje (otra rama), aunque el texto sea el mismo.
  const message = new HumanMessage({ content: kind === "edit" ? text! : start.original.text, id: randomUUID() });
  const branch = await (agent.graph as unknown as { updateState(c: RunnableConfig, v: unknown, asNode: string): Promise<RunnableConfig> }).updateState(
    start.config,
    { messages: [message] },
    "__start__",
  );
  const replacedActions = executedActions(start.replaced).map((a) => a.text);
  yield { type: "turn", kind, humanMessageId: message.id!, ...(replacedActions.length && { replacedActions }) };
  yield* streamInvoke(agent, threadId, null, start.before.length + 1, {
    signal,
    checkpoint: { checkpoint_id: checkpointIdOf(branch), checkpoint_ns: "" },
    trace: { kind, input: message.text },
  });
}

/** «Editar y volver a preguntar» (R10): el turno de ese mensaje, de nuevo, con otro texto. */
export function streamForkTurn(agent: TurnAgent & { graph: HistoryGraph }, threadId: string, messageId: string, text: string, signal?: AbortSignal) {
  return streamBranch(agent, threadId, messageId, "edit", text, signal);
}

/** «Reintentar» (R11): el turno de ese mensaje, de nuevo, con el mismo texto. */
export function streamReplayTurn(agent: TurnAgent & { graph: HistoryGraph }, threadId: string, messageId: string, signal?: AbortSignal) {
  return streamBranch(agent, threadId, messageId, "retry", undefined, signal);
}
