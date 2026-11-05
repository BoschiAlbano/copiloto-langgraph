import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { byCreation, checkpointIdOf, executedActions, messagesOf, pathTo, readHistory, type HistoryGraph, type HistorySnapshot, type ThreadHistory } from "./history.js";
import { ThreadAwaitingApprovalError, ThreadPendingError } from "./run-turn.js";
import { parseThreadId } from "./thread-id.js";
import { conversationMessages, getStatus, type ThreadGraph } from "./threads.js";

// Las ramas del hilo (specs/ramas-del-hilo.md). Editar o reintentar un turno bifurca el hilo (fase 10); acá se listan
// las ramas y se abre una. No hay tabla propia: todo sale de la historia de LangGraph.
//
// - Una RAMA es un camino desde el inicio del hilo hasta una PUNTA (un checkpoint sin hijos). Cada rama tiene una sola.
// - Una BIFURCACIÓN es un checkpoint con más de un hijo. El hijo más viejo sigue la rama de la que salió; cada hijo
//   más nuevo empieza una rama nueva (la que se creó al editar o reintentar).
// - ABRIR una rama es `updateState(punta, null)`: un checkpoint hijo de esa punta, con los mismos valores, que pasa a ser
//   el último del hilo. La copia es la nueva punta de la misma rama, así que las ramas no se duplican al ir y volver.

export interface Branch {
  /** La punta: lo que se pide para abrirla. Cambia cada vez que se abre (la copia es la nueva punta). */
  tipId: string;
  /** El número de versión, por orden de creación (la original es la 1). No cambia al ir y volver. */
  version: number;
  /** El checkpoint del que salió (no lo tiene la original). */
  forkFromId?: string;
  /** La versión de la que salió (no lo tiene la original): para dibujar el árbol. */
  parentVersion?: number;
  /** El mensaje de la persona con el que se separa de las otras. */
  label: string;
  /** Mensajes de la conversación (de la persona y del copiloto, como en la barra de hilos). */
  messageCount: number;
  /** Cuándo cambió por última vez. */
  updatedAt?: string;
  /** Es la rama actual del hilo. */
  current: boolean;
  /** Su último turno terminó (sin tarjeta ni turno a medias). Solo una rama terminada se puede abrir. */
  complete: boolean;
  /** Las acciones que esta rama ejecutó y que NO están en la actual: siguen en la base aunque no se vean (R7). */
  executedActions: string[];
}

export interface BranchTree {
  threadId: string;
  /** Las ramas, por número de versión. Vacío si el hilo no existe. */
  branches: Branch[];
}

/** El checkpoint pedido no es la punta de una rama de este hilo. */
export class BranchNotFoundError extends Error {
  constructor(tipId: string) {
    super(`Esa versión (${tipId}) no es parte de este hilo, o cambió desde que se abrió el panel.`);
    this.name = "BranchNotFoundError";
  }
}

/** La rama pedida no terminó su último turno: abrirla perdería lo que quedó pendiente (spec, R8). */
export class BranchIncompleteError extends Error {
  constructor() {
    super("Esa versión quedó incompleta y no se puede abrir.");
    this.name = "BranchIncompleteError";
  }
}

const firstHuman = (messages: BaseMessage[]) => messages.find((m) => HumanMessage.isInstance(m))?.text;

/** Dónde empieza la rama de esa punta: el checkpoint del que salió (si no es la original) y su primer checkpoint propio. */
function startOf(history: ThreadHistory, path: HistorySnapshot[]) {
  for (let i = path.length - 1; i > 0; i--) {
    const parent = checkpointIdOf(path[i - 1]!.config);
    const siblings = history.children.get(parent) ?? [];
    if (siblings.length > 1 && siblings[0] !== checkpointIdOf(path[i]!.config)) return { forkFrom: path[i - 1]!, first: path[i]! };
  }
  return { first: path[0]! };
}

/** El primer checkpoint con más de un hijo en el camino (para la etiqueta de la original). */
const firstFork = (history: ThreadHistory, path: HistorySnapshot[]) =>
  path.find((s) => (history.children.get(checkpointIdOf(s.config))?.length ?? 0) > 1);

/** Las ramas del hilo, como un árbol (spec, R1 a R3 y R7). */
export async function listBranches(graph: HistoryGraph, threadId: string): Promise<BranchTree> {
  return buildTree(await readHistory(graph, threadId), threadId);
}

/** El árbol a partir de una historia ya leída (leerla es lo que cuesta: se hace una sola vez por pedido). */
function buildTree(history: ThreadHistory, threadId: string): BranchTree {
  const latest = history.latest;
  if (!latest) return { threadId, branches: [] };
  const currentTip = checkpointIdOf(latest.config);
  const currentActions = new Set(executedActions(messagesOf(latest)).map((a) => a.id));

  const tips = [...history.byId.keys()].filter((id) => !history.children.get(id)?.length);
  const branches = tips
    .map((tipId) => {
      const tip = history.byId.get(tipId)!;
      const path = pathTo(history, tipId);
      const { forkFrom, first } = startOf(history, path);
      // La etiqueta: el primer mensaje de la persona después de donde se separa. La original se separa de las demás en
      // su primera bifurcación; sin bifurcaciones, es el primer mensaje del hilo.
      const from = forkFrom ?? firstFork(history, path);
      const messages = messagesOf(tip);
      const label = firstHuman(messages.slice(messagesOf(from).length)) ?? firstHuman(messages) ?? "(sin mensajes)";
      return {
        first,
        branch: {
          tipId,
          version: 0,
          ...(forkFrom && { forkFromId: checkpointIdOf(forkFrom.config) }),
          label,
          messageCount: conversationMessages(messages).length,
          updatedAt: tip.createdAt,
          current: tipId === currentTip,
          complete: tip.next.length === 0,
          executedActions: executedActions(messages)
            .filter((a) => !currentActions.has(a.id))
            .map((a) => a.text),
        } satisfies Branch,
      };
    })
    // El número de versión sale de cuándo se creó el primer checkpoint propio de cada rama: no cambia al ir y volver.
    .sort((a, b) => byCreation(a.first, b.first))
    .map(({ branch }, index): Branch => ({ ...branch, version: index + 1 }));
  // La rama madre de cada una: desde su bifurcación, la que sigue por los hijos más viejos hasta una punta (la que
  // continúa por ahí sin haberse separado).
  const versionOfTip = new Map(branches.map((b) => [b.tipId, b.version]));
  for (const branch of branches) {
    if (!branch.forkFromId) continue;
    let id = branch.forkFromId;
    for (let next = history.children.get(id)?.[0]; next; next = history.children.get(id)?.[0]) id = next;
    branch.parentVersion = versionOfTip.get(id);
  }
  return { threadId, branches };
}

/** Lo que el grafo tiene que permitir para abrir una rama. */
export type BranchGraph = HistoryGraph &
  ThreadGraph & { updateState(config: RunnableConfig, values: unknown, asNode?: string): Promise<RunnableConfig> };

export interface SwitchResult {
  /** El número de versión de la rama abierta. */
  version: number;
  /** Ya era la actual: no se hizo nada. */
  unchanged: boolean;
  /** Las acciones que ejecutó la rama que se dejó y que la abierta no tiene: siguen en la base (R7). */
  leftActions: string[];
}

/**
 * Abre una rama (spec, R5, R6 y R9): con el hilo listo, si `tipId` es la punta de una rama terminada de este hilo,
 * `updateState(punta, null)` la vuelve la actual. No llama al modelo ni toca la base del negocio.
 */
export async function switchBranch(graph: BranchGraph, threadId: string, tipId: string): Promise<SwitchResult> {
  const status = await getStatus(graph, threadId);
  if (status.awaiting) throw new ThreadAwaitingApprovalError(threadId, status.awaiting);
  if (status.pending) throw new ThreadPendingError(threadId, status.next);

  const history = await readHistory(graph, threadId);
  const target = buildTree(history, threadId).branches.find((b) => b.tipId === tipId);
  if (!target) throw new BranchNotFoundError(tipId);
  if (target.current) return { version: target.version, unchanged: true, leftActions: [] };
  if (!target.complete) throw new BranchIncompleteError();

  await graph.updateState({ configurable: { thread_id: parseThreadId(threadId), checkpoint_id: tipId, checkpoint_ns: "" } }, null);
  // Lo que la rama que se deja había ejecutado y la abierta no tiene: sigue en la base aunque ya no se vea.
  const kept = new Set(executedActions(messagesOf(history.byId.get(tipId))).map((a) => a.id));
  const leftActions = executedActions(messagesOf(history.latest))
    .filter((a) => !kept.has(a.id))
    .map((a) => a.text);
  return { version: target.version, unchanged: false, leftActions };
}
