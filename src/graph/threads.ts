import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { Pool } from "pg";
import type { Approval, ApprovalRequest, PendingAction } from "./approval.js";
import { CHECKPOINT_SCHEMA } from "./checkpointing.js";
import type { Intent } from "./intents.js";
import { parseThreadId } from "./thread-id.js";

/** Lo mínimo que se le pide al grafo compilado: leer su estado guardado. */
export interface Snapshot {
  values: {
    messages?: BaseMessage[];
    intent?: Intent;
    intentReason?: string;
    // Privados del subgrafo de acciones (fase 7): solo aparecen en el estado de ese subgrafo.
    pendingAction?: PendingAction | null;
    approval?: Approval | null;
  };
  /** Nodos que correrían a continuación; vacío si el turno terminó. */
  next: string[];
  config: { configurable?: Record<string, unknown> };
  metadata?: { source?: string; step?: number };
  createdAt?: string;
  /**
   * Las tareas del próximo paso. Con `getState(…, { subgraphs: true })`, la de un subgrafo que quedó a medias (por
   * ejemplo, pausado esperando una aprobación) trae en `state` el estado de ese subgrafo.
   */
  tasks?: { id?: string; name: string; state?: unknown; error?: unknown }[];
}

type ThreadConfig = { configurable: { thread_id: string; checkpoint_ns?: string } };

export interface ThreadGraph {
  getState(config: ThreadConfig, options?: { subgraphs?: boolean }): Promise<Snapshot>;
  getStateHistory(config: ThreadConfig): AsyncIterableIterator<Snapshot>;
}

export const FIRST_MESSAGE_CHARS = 80;
export const DEFAULT_THREAD_LIMIT = 20;

/** Mensajes de la conversación tal como la ve la persona: lo que dijo ella y lo que contestó la IA con texto. */
export function conversationMessages(messages: BaseMessage[] = []): BaseMessage[] {
  return messages.filter(
    (m) => HumanMessage.isInstance(m) || (AIMessage.isInstance(m) && m.text.trim().length > 0),
  );
}

/** Nodo donde el grafo se pausa a esperar la decisión de la persona. */
export const APPROVAL_NODE = "await_approval";

export interface ThreadStatus {
  /** ¿Hay algo guardado para este hilo? */
  exists: boolean;
  /** Quedó a medias POR UNA FALLA: hay nodos pendientes y no es una espera de aprobación. Se reanuda con `continueTurn`. */
  pending: boolean;
  /** Espera la decisión de la persona sobre una acción propuesta. Se reanuda con `resumeTurn`. */
  awaiting?: ApprovalRequest;
  next: string[];
  messages: BaseMessage[];
}

const isSnapshot = (value: unknown): value is Snapshot =>
  typeof value === "object" && value !== null && "values" in value && Array.isArray((value as Snapshot).next);

/**
 * El estado más adentro que quedó a medias: si un subgrafo está pausado (o se cortó) a mitad de camino, es el de ese
 * subgrafo; si no, el mismo. Ahí están lo privado (la propuesta) y los mensajes que el subgrafo todavía no devolvió.
 */
async function innermost(
  graph: ThreadGraph,
  threadId: string,
  snapshot: Snapshot,
  path: string[] = [],
): Promise<{ inner: Snapshot; path: string[] }> {
  for (const task of snapshot.tasks ?? []) {
    // Si el subgrafo se pausó, la tarea trae su estado. Si falló, trae el error pero no el estado: se lo pide por su
    // espacio de nombres (`nodo:id-de-la-tarea`), que es donde el checkpointer guardó sus pasos.
    let state = isSnapshot(task.state) ? task.state : undefined;
    if (!state && task.error !== undefined && task.id) {
      const parent = String(snapshot.config.configurable?.checkpoint_ns ?? "");
      const ns = parent ? `${parent}|${task.name}:${task.id}` : `${task.name}:${task.id}`;
      state = await graph.getState({ configurable: { thread_id: threadId, checkpoint_ns: ns } });
    }
    if (state && state.next.length > 0) return innermost(graph, threadId, state, [...path, task.name]);
  }
  return { inner: snapshot, path };
}

/** Estado actual de un hilo, a partir de su último checkpoint (y del de su subgrafo, si quedó uno a medias). */
export async function getStatus(graph: ThreadGraph, threadId: string): Promise<ThreadStatus> {
  const id = parseThreadId(threadId);
  const snapshot = await graph.getState({ configurable: { thread_id: id } }, { subgraphs: true });
  // Desde la fase 7 la pausa ocurre DENTRO del subgrafo de acciones: la propuesta es privada de él.
  const { inner, path } = await innermost(graph, id, snapshot);
  const action = inner.values.pendingAction;
  // La tarjeta se reconstruye del estado guardado (no del resultado de un `invoke`): así se puede mostrar tras reiniciar.
  const awaiting: ApprovalRequest | undefined =
    inner.next.includes(APPROVAL_NODE) && action
      ? {
          kind: "approve_action",
          action,
          ...(inner.values.approval?.decision === "invalid" && inner.values.approval.error
            ? { error: inner.values.approval.error }
            : {}),
          ...(inner.values.approval?.decision === "revised" ? { edited: true as const } : {}),
        }
      : undefined;
  return {
    exists: snapshot.config.configurable?.checkpoint_id !== undefined,
    pending: snapshot.next.length > 0 && !awaiting,
    ...(awaiting && { awaiting }),
    // Si lo pendiente está dentro de un subgrafo, con su ruta: "action_graph/execute_action".
    next: path.length ? inner.next.map((n) => [...path, n].join("/")) : snapshot.next,
    // Los del subgrafo a medias incluyen los del grafo principal más lo que ese subgrafo ya escribió.
    messages: inner.values.messages ?? snapshot.values.messages ?? [],
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
  /** Quedó a medias por una falla. */
  pending: boolean;
  /** Espera la aprobación de una acción. */
  awaiting: boolean;
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
        awaiting: Boolean(status.awaiting),
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

/**
 * Historia de checkpoints de un hilo, del más nuevo al más viejo. Solo se inspecciona; no se modifica. Es la del grafo
 * principal (o la de un subgrafo, si se pasa su espacio de nombres): el paso por un subgrafo cuenta como UN paso.
 */
export async function getHistory(graph: ThreadGraph, threadId: string, namespace?: string): Promise<CheckpointInfo[]> {
  const snapshots: Snapshot[] = [];
  const config = { configurable: { thread_id: parseThreadId(threadId), ...(namespace && { checkpoint_ns: namespace }) } };
  for await (const snapshot of graph.getStateHistory(config)) {
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

/** Una corrida de un subgrafo dentro de un hilo: cada vez que el supervisor le pasó una tarea (fase 7). */
export interface SubgraphRun {
  /** El espacio de nombres de sus checkpoints, `nodo:id-de-la-tarea` (por ejemplo `action_graph:3f2a…`). */
  namespace: string;
  /** El nodo del grafo principal que la corrió: `query_graph`, `action_graph` o `report_graph`. */
  node: string;
  /** Sus checkpoints, del más nuevo al más viejo. */
  checkpoints: CheckpointInfo[];
}

/**
 * Las corridas de subgrafos de un hilo, de la más vieja a la más nueva, con sus pasos internos. Cada subgrafo guarda
 * sus checkpoints con el mismo checkpointer que el grafo principal, en su propio espacio de nombres; LangGraph no
 * ofrece "listar espacios de nombres", así que se sacan del checkpointer (que, sin `checkpoint_ns`, devuelve todos).
 */
export async function getSubgraphHistory(
  graph: ThreadGraph,
  saver: Pick<BaseCheckpointSaver, "list">,
  threadId: string,
): Promise<SubgraphRun[]> {
  const id = parseThreadId(threadId);
  const firstSeen = new Map<string, string>();
  for await (const tuple of saver.list({ configurable: { thread_id: id } })) {
    const ns = String(tuple.config.configurable?.checkpoint_ns ?? "");
    const ts = tuple.checkpoint.ts;
    if (ns && (!firstSeen.has(ns) || ts < firstSeen.get(ns)!)) firstSeen.set(ns, ts);
  }
  const namespaces = [...firstSeen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([ns]) => ns);
  return Promise.all(
    namespaces.map(async (namespace) => ({
      namespace,
      node: namespace.split("|").at(-1)!.split(":")[0]!,
      checkpoints: await getHistory(graph, id, namespace),
    })),
  );
}

/** Borra el hilo de las tres tablas del checkpointer. Los demás hilos no se tocan. */
export async function deleteThread(saver: Pick<BaseCheckpointSaver, "deleteThread">, threadId: string) {
  await saver.deleteThread(parseThreadId(threadId));
}
