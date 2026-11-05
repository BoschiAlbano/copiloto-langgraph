import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import type { ApprovalRequest, HumanDecision } from "./approval.js";
import type { Agent } from "./create-agent.js";
import type { Intent } from "./intents.js";
import { AGENT_RECURSION_LIMIT } from "./limits.js";
import type { Plan } from "./plan.js";
import type { Section } from "./report/state.js";
import { toUiEvents, type StreamChunk, type UiEvent } from "../web/events.js";
import { parseThreadId } from "./thread-id.js";
import { getStatus } from "./threads.js";
import { agentSteps, summarizeTurn, type AgentStep, type TurnSummary } from "./usage.js";
import { UsageTracker, type ModelUsage } from "./usage-tracker.js";

export interface TurnResult {
  /** Respuesta final. Vacía si el turno quedó esperando una aprobación (ahí manda `awaiting`). */
  reply: string;
  /** Ruta que eligió el router y por qué; `tasks`, las partes del pedido en el orden en que se hacen (fase 7). */
  route: { intent?: Intent; reason?: string; tasks?: { intent: Intent; request: string }[] };
  summary: TurnSummary;
  /** Los agentes que intervinieron en esta invocación, en orden, con sus herramientas y su uso (fase 7). */
  agents: AgentStep[];
  /** Lo que gastó la coordinación (el router), aparte de los agentes. */
  coordination: ModelUsage[];
  /** Cuántas memorias del negocio estaban en contexto al terminar el turno (fase 8). */
  memoryCount: number;
  /** El grafo se pausó: hay una acción propuesta esperando la decisión (`resumeTurn`). */
  awaiting?: ApprovalRequest;
  /** Si el turno fue un reporte: el período y cómo salió cada sección. */
  report?: { label: string; notice?: string; sections: Record<Section, "ok" | "error" | "missing"> };
}

/** Lo mínimo que hace falta del agente: el grafo con checkpointer. Los tests pasan grafos propios. */
export type TurnAgent = Pick<Agent, "graph">;

type TurnInput = { messages: HumanMessage[] } | Command | null;

/**
 * La respuesta de un turno: lo que contestó cada agente, en orden (fase 7). Cuenta un mensaje de IA con texto y sin
 * llamadas a herramientas; el texto que acompaña a una llamada ("voy a consultar…") no es una respuesta.
 */
export function turnReply(messages: BaseMessage[]): string {
  return messages
    .filter((m) => AIMessage.isInstance(m) && !m.tool_calls?.length && m.text.trim().length > 0)
    .map((m) => m.text)
    .join("\n\n");
}

/**
 * Los modos de `graph.stream` en cada turno, también dentro de los subgrafos: los tres de la fase 9 y `custom` (fase 10),
 * por donde las lecturas de la base avisan sus reintentos.
 */
const STREAM_MODES = ["values", "updates", "messages", "custom"] as const;

/**
 * Corre el grafo con `graph.stream` y produce los eventos de la interfaz a medida que pasan (fase 9). El último evento
 * es `done`, con el mismo `TurnResult` que antes devolvía `invoke`: así la terminal y la web usan un solo camino.
 *
 * @param already cuántos mensajes del hilo ya existían (y no son de esta llamada) cuando se invoca. El resumen
 *   del turno cuenta solo lo que se agregó después: así, al decidir o continuar, no se vuelven a listar las
 *   herramientas que se usaron antes de la pausa.
 * @param signal corta el turno (por ejemplo, si se cierra la página). El hilo queda a medias, como tras una falla.
 */
export async function* streamInvoke(
  agent: TurnAgent,
  threadId: string,
  input: TurnInput,
  already: number,
  signal?: AbortSignal,
  /** Fase 10: desde qué checkpoint correr (una rama nueva del viaje en el tiempo); sin esto, desde el último. */
  checkpoint?: { checkpoint_id?: string; checkpoint_ns?: string },
): AsyncGenerator<UiEvent> {
  const tracker = new UsageTracker();
  // El tipo de `Command` del grafo compilado exige los nombres de nodo exactos; acá solo se usa `resume`.
  const stream = await agent.graph.stream(input as never, {
    configurable: { thread_id: parseThreadId(threadId), ...checkpoint },
    recursionLimit: AGENT_RECURSION_LIMIT,
    callbacks: [tracker],
    streamMode: [...STREAM_MODES],
    subgraphs: true,
    ...(signal && { signal }),
  });
  let state: Partial<StateOf> = {};
  let awaiting: ApprovalRequest | undefined;
  for await (const chunk of stream as AsyncIterable<StreamChunk>) {
    const [namespace, mode, data] = chunk;
    // El estado del grafo principal después de cada paso: el último es el final (o el de la pausa).
    // Al pausarse, el modo values manda además un dato que es solo `{ __interrupt__ }`: ese no es el estado.
    if (mode === "values" && namespace.length === 0 && !(data as object && "__interrupt__" in (data as object))) state = data as Partial<StateOf>;
    for (const event of toUiEvents(chunk)) {
      if (event.type === "approval") awaiting = event.request;
      yield event;
    }
  }
  yield { type: "done", result: await turnResult(agent, threadId, state, awaiting, tracker, already) };
}

type StateOf = {
  messages: BaseMessage[];
  intent: Intent;
  intentReason: string;
  plan: Plan;
  report: { label: string; notice?: string; sections?: Record<Section, "ok" | "error" | "missing"> };
  businessContext: unknown[];
};

async function turnResult(
  agent: TurnAgent,
  threadId: string,
  state: Partial<StateOf>,
  awaiting: ApprovalRequest | undefined,
  tracker: UsageTracker,
  already: number,
): Promise<TurnResult> {
  // Durante una pausa, los mensajes del subgrafo todavía no volvieron al grafo principal: se leen del hilo guardado.
  // La pausa ocurre dentro del subgrafo de acciones, y `stream` la informa igual en el grafo principal.
  const messages: BaseMessage[] = awaiting ? (await getStatus(agent.graph, threadId)).messages : (state.messages ?? []);
  const plan = state.plan;
  const report = state.report;
  return {
    // El texto del modelo que acompaña a una acción propuesta no se muestra como respuesta: manda la tarjeta.
    reply: awaiting ? "" : turnReply(messages.slice(already)),
    route: {
      intent: state.intent,
      reason: state.intentReason,
      ...(plan && { tasks: plan.tasks.map((t) => ({ intent: t.intent, request: t.request })) }),
    },
    summary: summarizeTurn(messages.slice(already), tracker.usage()),
    ...agentSteps({ plan, messages, already, runs: tracker.runs(), awaiting: Boolean(awaiting) }),
    memoryCount: state.businessContext?.length ?? 0,
    ...(awaiting && { awaiting }),
    // `state.report` queda en el hilo después de un reporte: solo cuenta si ESTE turno tuvo un reporte terminado.
    ...(!awaiting && plan?.tasks.some((t) => t.intent === "report") && report?.sections
      ? { report: { label: report.label, ...(report.notice && { notice: report.notice }), sections: report.sections } }
      : {}),
  };
}

/** Consume los eventos de un turno y devuelve su resultado (lo que necesita la terminal). */
export async function collectTurn(events: AsyncIterable<UiEvent>): Promise<TurnResult> {
  for await (const event of events) if (event.type === "done") return event.result;
  throw new Error("El turno terminó sin resultado.");
}

/** El hilo quedó a medias por una falla: hay que reanudarlo con `continueTurn` antes de seguir conversando. */
export class ThreadPendingError extends Error {
  constructor(
    readonly threadId: string,
    readonly next: string[],
    message = `El hilo ${threadId} quedó a medias (falta correr: ${next.join(", ")}). Reanudalo antes de mandar otro mensaje.`,
  ) {
    super(message);
    this.name = "ThreadPendingError";
  }
}

/** El hilo espera la decisión de la persona sobre una acción: hay que resolverla con `resumeTurn`. */
export class ThreadAwaitingApprovalError extends ThreadPendingError {
  constructor(
    threadId: string,
    readonly request: ApprovalRequest,
  ) {
    super(threadId, ["await_approval"], `El hilo ${threadId} espera tu decisión sobre una acción: ${request.action.summary}`);
    this.name = "ThreadAwaitingApprovalError";
  }
}

/**
 * Un turno de conversación: mensaje de la persona → respuesta final, con la ruta y el uso.
 * Se manda solo el mensaje nuevo: el historial lo pone el checkpointer a partir del `threadId`.
 * Si el modelo pide una acción, el turno termina pausado y el resultado trae `awaiting`.
 */
export async function* streamRunTurn(agent: TurnAgent, threadId: string, input: string, signal?: AbortSignal): AsyncGenerator<UiEvent> {
  // Detrás de una llamada a herramienta sin respuesta, un mensaje nuevo rompe la API de Claude.
  const status = await getStatus(agent.graph, threadId);
  if (status.awaiting) throw new ThreadAwaitingApprovalError(threadId, status.awaiting);
  if (status.pending) throw new ThreadPendingError(threadId, status.next);
  // Fase 10: el mensaje lleva un id propio y el turno lo avisa primero (`turn`): así la web puede editarlo o
  // reintentarlo después, aunque lo haya escrito en esta misma sesión.
  const message = new HumanMessage({ content: input, id: randomUUID() });
  yield { type: "turn", kind: "new", humanMessageId: message.id! };
  // El mensaje de la persona es el primero de este turno: lo que ya había más ese mensaje no cuenta como "nuevo".
  yield* streamInvoke(agent, threadId, { messages: [message] }, status.messages.length + 1, signal);
}

export function runTurn(agent: TurnAgent, threadId: string, input: string): Promise<TurnResult> {
  return collectTurn(streamRunTurn(agent, threadId, input));
}

/**
 * Reanuda un turno que quedó a medias por una falla, desde su último checkpoint. No repite el mensaje de la
 * persona: `invoke(null)` significa "seguí donde quedaste". El uso informado es solo el de esta reanudación.
 */
export async function* streamContinueTurn(agent: TurnAgent, threadId: string, signal?: AbortSignal): AsyncGenerator<UiEvent> {
  const status = await getStatus(agent.graph, threadId);
  if (status.awaiting) throw new ThreadAwaitingApprovalError(threadId, status.awaiting);
  yield* streamInvoke(agent, threadId, null, status.messages.length, signal);
}

export function continueTurn(agent: TurnAgent, threadId: string): Promise<TurnResult> {
  return collectTurn(streamContinueTurn(agent, threadId));
}

/** Se intentó decidir sobre un hilo que no espera ninguna decisión. */
export class NothingToDecideError extends Error {
  constructor(threadId: string) {
    super(`El hilo ${threadId} no está esperando ninguna decisión.`);
    this.name = "NothingToDecideError";
  }
}

/**
 * Entrega la decisión de la persona (aprobar, rechazar o editar) a un hilo pausado y lo reanuda. Una decisión
 * mal formada no ejecuta nada: el grafo vuelve a preguntar y el resultado trae `awaiting` con el motivo.
 */
export async function* streamResumeTurn(agent: TurnAgent, threadId: string, decision: HumanDecision, signal?: AbortSignal): AsyncGenerator<UiEvent> {
  const status = await getStatus(agent.graph, threadId);
  if (!status.awaiting) throw new NothingToDecideError(threadId);
  yield* streamInvoke(agent, threadId, new Command({ resume: decision }), status.messages.length, signal);
}

export function resumeTurn(agent: TurnAgent, threadId: string, decision: HumanDecision): Promise<TurnResult> {
  return collectTurn(streamResumeTurn(agent, threadId, decision));
}
