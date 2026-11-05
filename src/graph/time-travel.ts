import { randomUUID } from "node:crypto";
import { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { isActionName } from "../tools/actions/schemas.js";
import type { UiEvent } from "../web/events.js";
import { streamInvoke, ThreadAwaitingApprovalError, ThreadPendingError, type TurnAgent } from "./run-turn.js";
import { parseThreadId } from "./thread-id.js";
import { getStatus, type Snapshot } from "./threads.js";

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

/** Lo que se puede leer de la historia del grafo (el grafo compilado lo cumple). */
export interface HistoryGraph {
  getStateHistory(config: RunnableConfig): AsyncIterable<Snapshot & { parentConfig?: RunnableConfig }>;
}

const idOf = (config?: RunnableConfig) => String(config?.configurable?.checkpoint_id ?? "");
const hasMessage = (snapshot: Snapshot, messageId: string) =>
  (snapshot.values.messages ?? []).some((m: BaseMessage) => HumanMessage.isInstance(m) && m.id === messageId);

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
 * LangGraph trae los checkpoints de todas las ramas: se arma un mapa y se sigue la cadena de padres desde el último.
 */
export async function findTurnStart(graph: HistoryGraph, threadId: string, messageId: string): Promise<TurnStart> {
  const all = new Map<string, Snapshot & { parentConfig?: RunnableConfig }>();
  let latest: (Snapshot & { parentConfig?: RunnableConfig }) | undefined;
  for await (const snapshot of graph.getStateHistory({ configurable: { thread_id: parseThreadId(threadId) } })) {
    latest ??= snapshot; // la historia viene de la más nueva a la más vieja
    all.set(idOf(snapshot.config), snapshot);
  }
  if (!latest || !hasMessage(latest, messageId)) throw new TurnNotFoundError(messageId);
  // Hacia atrás por la rama actual: el primer checkpoint SIN el mensaje es donde entró (su `input`).
  let current = all.get(idOf(latest.parentConfig));
  while (current && hasMessage(current, messageId)) current = all.get(idOf(current.parentConfig));
  if (!current) throw new TurnNotFoundError(messageId);
  const messages: BaseMessage[] = latest.values.messages ?? [];
  const at = messages.findIndex((m) => m.id === messageId);
  const original = messages[at] as HumanMessage;
  return { config: current.config, before: current.values.messages ?? [], original, replaced: messages.slice(at) };
}

/** Las acciones que la rama que se reemplaza ya ejecutó (R13: no se deshacen). Su texto, como lo armó el código. */
function executedActions(messages: BaseMessage[]): string[] {
  return messages
    .filter((m): m is ToolMessage => ToolMessage.isInstance(m) && Boolean(m.name && isActionName(m.name)))
    .filter((m) => (m.artifact as { outcome?: string } | undefined)?.outcome === "executed")
    .map((m) => m.text);
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
  const replacedActions = executedActions(start.replaced);
  yield { type: "turn", kind, humanMessageId: message.id!, ...(replacedActions.length && { replacedActions }) };
  yield* streamInvoke(agent, threadId, null, start.before.length + 1, signal, { checkpoint_id: idOf(branch), checkpoint_ns: "" });
}

/** «Editar y volver a preguntar» (R10): el turno de ese mensaje, de nuevo, con otro texto. */
export function streamForkTurn(agent: TurnAgent & { graph: HistoryGraph }, threadId: string, messageId: string, text: string, signal?: AbortSignal) {
  return streamBranch(agent, threadId, messageId, "edit", text, signal);
}

/** «Reintentar» (R11): el turno de ese mensaje, de nuevo, con el mismo texto. */
export function streamReplayTurn(agent: TurnAgent & { graph: HistoryGraph }, threadId: string, messageId: string, signal?: AbortSignal) {
  return streamBranch(agent, threadId, messageId, "retry", undefined, signal);
}
