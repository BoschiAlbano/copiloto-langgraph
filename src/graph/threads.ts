import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { Pool } from "pg";
import { CHECKPOINT_SCHEMA } from "./checkpointing.js";
import type { Intent } from "./intents.js";
import { parseThreadId } from "./thread-id.js";

/** Lo mínimo que se le pide al grafo compilado: leer su estado guardado. */
export interface Snapshot {
  values: { messages?: BaseMessage[]; intent?: Intent; intentReason?: string };
  /** Nodos que correrían a continuación; vacío si el turno terminó. */
  next: string[];
  config: { configurable?: Record<string, unknown> };
  metadata?: { source?: string; step?: number };
  createdAt?: string;
}

export interface ThreadGraph {
  getState(config: { configurable: { thread_id: string } }): Promise<Snapshot>;
  getStateHistory(config: { configurable: { thread_id: string } }): AsyncIterableIterator<Snapshot>;
}

export const FIRST_MESSAGE_CHARS = 80;
export const DEFAULT_THREAD_LIMIT = 20;

/** Mensajes de la conversación tal como la ve la persona: lo que dijo ella y lo que contestó la IA con texto. */
export function conversationMessages(messages: BaseMessage[] = []): BaseMessage[] {
  return messages.filter(
    (m) => HumanMessage.isInstance(m) || (AIMessage.isInstance(m) && m.text.trim().length > 0),
  );
}

export interface ThreadStatus {
  /** ¿Hay algo guardado para este hilo? */
  exists: boolean;
  /** Quedó a medias: hay nodos pendientes (se cortó antes de llegar a END). */
  pending: boolean;
  next: string[];
  messages: BaseMessage[];
}

/** Estado actual de un hilo, a partir de su último checkpoint. */
export async function getStatus(graph: ThreadGraph, threadId: string): Promise<ThreadStatus> {
  const snapshot = await graph.getState({ configurable: { thread_id: parseThreadId(threadId) } });
  return {
    exists: snapshot.config.configurable?.checkpoint_id !== undefined,
    pending: snapshot.next.length > 0,
    next: snapshot.next,
    messages: snapshot.values.messages ?? [],
  };
}

export interface ThreadSummary {
  threadId: string;
  lastActivity: Date;
  checkpoints: number;
  /** Mensajes de la conversación (persona e IA con texto). */
  messageCount: number;
  /** Lo primero que dijo la persona, recortado. */
  firstMessage: string;
  pending: boolean;
}

function clip(text: string, max: number) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Hilos guardados, del más reciente al más viejo. LangGraph no ofrece "listar hilos": se agrupan
 * los checkpoints de la tabla del paquete (consulta fija y parametrizada) y el resto sale del estado.
 */
export async function listThreads(
  { pool, graph }: { pool: Pool; graph: ThreadGraph },
  limit = DEFAULT_THREAD_LIMIT,
): Promise<ThreadSummary[]> {
  const { rows } = await pool.query<{ thread_id: string; checkpoints: number; last_ts: string }>(
    `SELECT thread_id, COUNT(*)::int AS checkpoints, MAX(checkpoint->>'ts') AS last_ts
       FROM "${CHECKPOINT_SCHEMA}".checkpoints
      WHERE checkpoint_ns = ''
      GROUP BY thread_id
      ORDER BY MAX(checkpoint->>'ts') DESC
      LIMIT $1`,
    [Math.max(1, Math.floor(limit))],
  );

  return Promise.all(
    rows.map(async (row) => {
      const status = await getStatus(graph, row.thread_id);
      const conversation = conversationMessages(status.messages);
      const first = conversation.find((m) => HumanMessage.isInstance(m));
      return {
        threadId: row.thread_id,
        lastActivity: new Date(row.last_ts),
        checkpoints: row.checkpoints,
        messageCount: conversation.length,
        firstMessage: first ? clip(first.text, FIRST_MESSAGE_CHARS) : "",
        pending: status.pending,
      };
    }),
  );
}

export interface CheckpointInfo {
  checkpointId: string;
  /** "input" (entró el mensaje de la persona), "loop" (corrió un nodo), "update", "fork". */
  source: string;
  step: number;
  /**
   * Nodos que corrieron para producir este checkpoint. LangGraph.js no guarda `writes` en los
   * metadatos, así que se deducen: son los `next` del checkpoint anterior.
   */
  ranNodes: string[];
  /** Nodos que correrían a continuación; vacío si el turno terminó. */
  next: string[];
  messageCount: number;
  intent?: Intent;
  createdAt?: string;
}

/** Historia de checkpoints de un hilo, del más nuevo al más viejo. Solo se inspecciona; no se modifica. */
export async function getHistory(graph: ThreadGraph, threadId: string): Promise<CheckpointInfo[]> {
  const snapshots: Snapshot[] = [];
  for await (const snapshot of graph.getStateHistory({ configurable: { thread_id: parseThreadId(threadId) } })) {
    snapshots.push(snapshot);
  }
  return snapshots.map((snapshot, i) => ({
    checkpointId: String(snapshot.config.configurable?.checkpoint_id ?? ""),
    source: snapshot.metadata?.source ?? "?",
    step: snapshot.metadata?.step ?? 0,
    ranNodes: snapshots[i + 1]?.next ?? [],
    next: snapshot.next,
    messageCount: conversationMessages(snapshot.values.messages).length,
    intent: snapshot.values.intent,
    createdAt: snapshot.createdAt,
  }));
}

/** Borra el hilo de las tres tablas del checkpointer. Los demás hilos no se tocan. */
export async function deleteThread(saver: Pick<BaseCheckpointSaver, "deleteThread">, threadId: string) {
  await saver.deleteThread(parseThreadId(threadId));
}
