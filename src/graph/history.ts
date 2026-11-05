import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { isActionName } from "../tools/actions/schemas.js";
import { parseThreadId } from "./thread-id.js";
import type { Snapshot } from "./threads.js";

// La historia de un hilo como ÁRBOL de checkpoints (fase 10 y ramas del hilo). `getStateHistory` trae los checkpoints de
// todas las ramas mezclados, del más nuevo al más viejo; cada uno sabe quién es su padre. Este módulo arma el árbol una
// vez y lo comparten el viaje en el tiempo (editar, reintentar) y las ramas (listarlas, abrir una).

export type HistorySnapshot = Snapshot & { parentConfig?: RunnableConfig };

/** Lo que se puede leer de la historia del grafo (el grafo compilado lo cumple). */
export interface HistoryGraph {
  getStateHistory(config: RunnableConfig): AsyncIterable<HistorySnapshot>;
}

export const checkpointIdOf = (config?: RunnableConfig) => String(config?.configurable?.checkpoint_id ?? "");

export interface ThreadHistory {
  /** Cada checkpoint por su id. */
  byId: Map<string, HistorySnapshot>;
  /** Los hijos de cada checkpoint, del más viejo al más nuevo. */
  children: Map<string, string[]>;
  /** El último checkpoint: el estado actual del hilo (la punta de la rama actual). */
  latest?: HistorySnapshot;
}

/** Orden de creación: por fecha y, si empatan, por id (LangGraph usa ids que crecen con el tiempo). */
export function byCreation(a: HistorySnapshot, b: HistorySnapshot): number {
  return (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || checkpointIdOf(a.config).localeCompare(checkpointIdOf(b.config));
}

/** Lee la historia completa del hilo (todas las ramas) en una sola pasada. */
export async function readHistory(graph: HistoryGraph, threadId: string): Promise<ThreadHistory> {
  const byId = new Map<string, HistorySnapshot>();
  let latest: HistorySnapshot | undefined;
  for await (const snapshot of graph.getStateHistory({ configurable: { thread_id: parseThreadId(threadId) } })) {
    latest ??= snapshot; // la historia viene de la más nueva a la más vieja
    byId.set(checkpointIdOf(snapshot.config), snapshot);
  }
  const children = new Map<string, string[]>();
  for (const [id, snapshot] of byId) {
    const parent = checkpointIdOf(snapshot.parentConfig);
    if (parent && byId.has(parent)) children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  for (const [parent, ids] of children) children.set(parent, ids.sort((a, b) => byCreation(byId.get(a)!, byId.get(b)!)));
  return { byId, children, latest };
}

/** El camino desde la raíz del hilo hasta ese checkpoint, en orden. */
export function pathTo(history: ThreadHistory, checkpointId: string): HistorySnapshot[] {
  const path: HistorySnapshot[] = [];
  for (let current = history.byId.get(checkpointId); current; current = history.byId.get(checkpointIdOf(current.parentConfig))) {
    path.push(current);
  }
  return path.reverse();
}

export const messagesOf = (snapshot?: HistorySnapshot): BaseMessage[] => snapshot?.values.messages ?? [];

/**
 * Las acciones que se ejecutaron de verdad en esos mensajes (no las propuestas, rechazadas ni fallidas): el resultado
 * queda marcado en su mensaje de herramienta desde la fase 10 (`artifact: { outcome }`). Lo escrito en la base no se
 * deshace al cambiar de rama.
 */
export function executedActions(messages: BaseMessage[]): { id: string; text: string }[] {
  return messages
    .filter((m): m is ToolMessage => ToolMessage.isInstance(m) && Boolean(m.name && isActionName(m.name)))
    .filter((m) => (m.artifact as { outcome?: string } | undefined)?.outcome === "executed")
    .map((m) => ({ id: m.id ?? m.tool_call_id, text: m.text }));
}
