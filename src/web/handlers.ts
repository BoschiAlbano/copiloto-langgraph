import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { humanDecisionSchema, type ApprovalRequest } from "../graph/approval.js";
import { AGENT_RECURSION_LIMIT } from "../graph/limits.js";
import { NothingToDecideError, streamContinueTurn, streamResumeTurn, streamRunTurn, ThreadPendingError, type TurnAgent } from "../graph/run-turn.js";
import { threadIdSchema } from "../graph/thread-id.js";
import { streamForkTurn, streamReplayTurn, TurnNotFoundError, type HistoryGraph } from "../graph/time-travel.js";
import { conversationMessages, getStatus, type ThreadGraph, type ThreadSummary } from "../graph/threads.js";
import { deleteMemory, listMemories, type MemoryBank } from "../memory/store.js";
import type { UiEvent } from "./events.js";
import { checkMutation, jsonError, readJson } from "./guard.js";
import { ThreadLocks } from "./locks.js";
import { sseResponse } from "./sse.js";

// Las rutas de la app web, como funciones (Request) → Response, sin nada de Next (fase 9, R10). Las rutas de
// web/app/api solo las llaman; así se prueban con vitest como el resto del copiloto.

/** Largo máximo de un mensaje de la persona (R13). */
export const MAX_MESSAGE_CHARS = 4000;

const messageBodySchema = z.strictObject({
  text: z.string().trim().min(1, "El mensaje está vacío.").max(MAX_MESSAGE_CHARS, `El mensaje supera los ${MAX_MESSAGE_CHARS} caracteres.`),
});
const memoryIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** El id de un mensaje de la persona (los pone LangGraph o el servidor: uuid u otros ids cortos). */
const messageIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, "El id del mensaje no es válido.");
const editBodySchema = z.strictObject({ messageId: messageIdSchema, text: messageBodySchema.shape.text });
const retryBodySchema = z.strictObject({ messageId: messageIdSchema });

export interface WebDeps {
  /** El grafo compilado, con checkpointer (y su historia, para editar y reintentar). */
  graph: TurnAgent["graph"] & ThreadGraph & HistoryGraph;
  /** Los hilos recientes (con Postgres en la app; en los tests, lo que haga falta). */
  listThreads: () => Promise<ThreadSummary[]>;
  /** La memoria de largo plazo. Sin ella, el panel de memorias dice que no está disponible. */
  memory?: MemoryBank;
  locks?: ThreadLocks;
  /** Dónde se anotan los detalles de un error (en el servidor, nunca en el navegador). */
  log?: (message: string, error?: unknown) => void;
}

/** Un mensaje de la conversación, tal como lo dibuja la página. */
export interface ConversationMessage {
  id: string;
  role: "human" | "ai";
  /** `step`: el texto que acompañó a una herramienta (se muestra como paso, no como respuesta). */
  kind: "message" | "step";
  text: string;
}

/** Lo que devuelve `GET /api/threads/:id`: todo lo necesario para dibujar la página al abrirla o recargarla (R3). */
export interface ThreadView {
  threadId: string;
  exists: boolean;
  /** `ready`: se puede escribir. `awaiting`: hay una tarjeta. `pending`: un turno quedó a medias. */
  status: "ready" | "awaiting" | "pending";
  /** Hay un turno corriendo ahora mismo en el servidor (por ejemplo, en otra pestaña). */
  running: boolean;
  awaiting?: ApprovalRequest;
  next: string[];
  messages: ConversationMessage[];
}

/** El texto de un error para la persona. Los de sistema no muestran detalles: pueden tener datos internos. */
export function publicErrorMessage(error: unknown): string {
  const e = error as Error;
  if (e?.name === "GraphRecursionError") return `El agente superó el límite de ${AGENT_RECURSION_LIMIT} pasos y se detuvo.`;
  if (error instanceof ThreadPendingError || error instanceof NothingToDecideError || error instanceof TurnNotFoundError) return e.message;
  return "No se pudo completar el pedido por un problema del sistema. Si el turno quedó a medias, podés continuarlo.";
}

export function makeHandlers(deps: WebDeps) {
  const locks = deps.locks ?? new ThreadLocks();
  const log = deps.log ?? ((message: string, error?: unknown) => console.error(message, error));

  const parseId = (raw: string) => threadIdSchema.safeParse(raw);

  /**
   * Corre un turno en vivo: toma el hilo, une la señal del pedido con la del corte del navegador, y convierte una falla
   * en un evento `error` (con un texto sin detalles internos) en vez de cortar la conexión.
   */
  function stream(request: Request, threadId: string, run: (signal: AbortSignal) => AsyncGenerator<UiEvent>): Response {
    const release = locks.acquire(threadId);
    if (!release) return jsonError(409, "Este hilo ya tiene un turno en curso. Esperá a que termine.");
    const cut = new AbortController();
    const signal = AbortSignal.any([request.signal, cut.signal]);

    async function* guarded(): AsyncGenerator<UiEvent> {
      try {
        yield* run(signal);
      } catch (error) {
        if (signal.aborted) return; // la persona se fue: nadie lee el error
        log(`[web] Falló un turno del hilo ${threadId}`, error);
        const pending = (await getStatus(deps.graph, threadId).catch(() => undefined))?.pending ?? false;
        yield { type: "error", message: publicErrorMessage(error), pending };
      }
    }
    return sseResponse(guarded(), { onCancel: () => cut.abort(), onClose: release });
  }

  /**
   * Editar o reintentar (fase 10): los mismos controles que un mensaje nuevo (origen, JSON, ids, una tarjeta o un turno
   * a medias o en curso → 409), más que el mensaje esté en la conversación actual (404 si no).
   */
  async function branch<T>(
    request: Request,
    rawId: string,
    schema: z.ZodType<T>,
    run: (threadId: string, body: T, signal: AbortSignal) => AsyncGenerator<UiEvent>,
  ): Promise<Response> {
    const rejected = checkMutation(request);
    if (rejected) return rejected;
    const id = parseId(rawId);
    if (!id.success) return jsonError(400, id.error.issues[0]!.message);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) return jsonError(400, parsed.error.issues[0]!.message);
    const status = await getStatus(deps.graph, id.data);
    if (status.awaiting) return jsonError(409, "Este hilo espera tu decisión sobre una acción: resolvela antes de editar o reintentar.");
    if (status.pending) return jsonError(409, "Este hilo tiene un turno a medias: continualo antes de editar o reintentar.");
    const messageId = (parsed.data as { messageId: string }).messageId;
    if (!status.messages.some((m) => HumanMessage.isInstance(m) && m.id === messageId)) {
      return jsonError(404, "Ese mensaje no está en la conversación actual del hilo.");
    }
    return stream(request, id.data, (signal) => run(id.data, parsed.data, signal));
  }

  return {
    /** GET /api/threads */
    async listThreads(): Promise<Response> {
      try {
        return Response.json({ threads: await deps.listThreads() });
      } catch (error) {
        log("[web] No se pudieron listar los hilos", error);
        return jsonError(500, "No se pudieron leer los hilos.");
      }
    },

    /** GET /api/threads/:id */
    async getThread(rawId: string): Promise<Response> {
      const id = parseId(rawId);
      if (!id.success) return jsonError(400, id.error.issues[0]!.message);
      try {
        const status = await getStatus(deps.graph, id.data);
        const view: ThreadView = {
          threadId: id.data,
          exists: status.exists,
          status: status.awaiting ? "awaiting" : status.pending ? "pending" : "ready",
          running: locks.isRunning(id.data),
          ...(status.awaiting && { awaiting: status.awaiting }),
          next: status.next,
          messages: conversationMessages(status.messages).map((m, i) => ({
            id: m.id ?? `m${i}`,
            role: HumanMessage.isInstance(m) ? "human" : "ai",
            kind: AIMessage.isInstance(m) && m.tool_calls?.length ? "step" : "message",
            text: m.text,
          })),
        };
        return Response.json(view);
      } catch (error) {
        log(`[web] No se pudo leer el hilo ${id.data}`, error);
        return jsonError(500, "No se pudo leer el hilo.");
      }
    },

    /** POST /api/threads/:id/messages  { text } → SSE */
    async postMessage(request: Request, rawId: string): Promise<Response> {
      const rejected = checkMutation(request);
      if (rejected) return rejected;
      const id = parseId(rawId);
      if (!id.success) return jsonError(400, id.error.issues[0]!.message);
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const message = messageBodySchema.safeParse(body.value);
      if (!message.success) return jsonError(400, message.error.issues[0]!.message);
      const status = await getStatus(deps.graph, id.data);
      if (status.awaiting) return jsonError(409, "Este hilo espera tu decisión sobre una acción: aprobala, rechazala o editala antes de escribir.");
      if (status.pending) return jsonError(409, "Este hilo tiene un turno a medias: continualo antes de escribir.");
      return stream(request, id.data, (signal) => streamRunTurn({ graph: deps.graph }, id.data, message.data.text, signal));
    },

    /** POST /api/threads/:id/decision  HumanDecision → SSE */
    async postDecision(request: Request, rawId: string): Promise<Response> {
      const rejected = checkMutation(request);
      if (rejected) return rejected;
      const id = parseId(rawId);
      if (!id.success) return jsonError(400, id.error.issues[0]!.message);
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const decision = humanDecisionSchema.safeParse(body.value);
      if (!decision.success) return jsonError(400, "La decisión no es válida: tiene que ser aprobar, rechazar (con motivo opcional) o editar (con los parámetros).");
      const status = await getStatus(deps.graph, id.data);
      if (!status.awaiting) return jsonError(409, "Este hilo no está esperando ninguna decisión.");
      return stream(request, id.data, (signal) => streamResumeTurn({ graph: deps.graph }, id.data, decision.data, signal));
    },

    /** POST /api/threads/:id/continue → SSE */
    async postContinue(request: Request, rawId: string): Promise<Response> {
      const rejected = checkMutation(request);
      if (rejected) return rejected;
      const id = parseId(rawId);
      if (!id.success) return jsonError(400, id.error.issues[0]!.message);
      const status = await getStatus(deps.graph, id.data);
      if (status.awaiting) return jsonError(409, "Este hilo espera tu decisión sobre una acción, no un «Continuar».");
      if (!status.pending) return jsonError(409, "No hay ningún turno a medias en este hilo.");
      return stream(request, id.data, (signal) => streamContinueTurn({ graph: deps.graph }, id.data, signal));
    },

    /** POST /api/threads/:id/edit  { messageId, text } → SSE (fase 10: editar y volver a preguntar) */
    async postEdit(request: Request, rawId: string): Promise<Response> {
      return branch(request, rawId, editBodySchema, (id, body, signal) => streamForkTurn({ graph: deps.graph }, id, body.messageId, body.text, signal));
    },

    /** POST /api/threads/:id/retry  { messageId } → SSE (fase 10: reintentar el turno de ese mensaje) */
    async postRetry(request: Request, rawId: string): Promise<Response> {
      return branch(request, rawId, retryBodySchema, (id, body, signal) => streamReplayTurn({ graph: deps.graph }, id, body.messageId, signal));
    },

    /** GET /api/memories */
    async listMemories(): Promise<Response> {
      if (!deps.memory) return jsonError(503, "La memoria no está disponible.");
      try {
        return Response.json({ memories: await listMemories(deps.memory) });
      } catch (error) {
        log("[web] No se pudieron leer las memorias", error);
        return jsonError(500, "No se pudieron leer las memorias.");
      }
    },

    /** DELETE /api/memories/:id */
    async deleteMemory(request: Request, rawId: string): Promise<Response> {
      const rejected = checkMutation(request);
      if (rejected) return rejected;
      if (!deps.memory) return jsonError(503, "La memoria no está disponible.");
      const id = memoryIdSchema.safeParse(rawId);
      if (!id.success) return jsonError(400, "El id de la memoria no es válido.");
      try {
        const deleted = await deleteMemory(deps.memory, id.data);
        if (!deleted) return jsonError(404, "Esa memoria ya no existe.");
        return Response.json({ deleted });
      } catch (error) {
        log(`[web] No se pudo borrar la memoria ${id.data}`, error);
        return jsonError(500, "No se pudo borrar la memoria.");
      }
    },
  };
}

export type WebHandlers = ReturnType<typeof makeHandlers>;
