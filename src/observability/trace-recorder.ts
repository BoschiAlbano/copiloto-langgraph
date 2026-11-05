import { randomUUID } from "node:crypto";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import type { Serialized } from "@langchain/core/load/serializable";
import { estimateCostUsd } from "../config/pricing.js";

// Las trazas (fase 11, R1 a R3). Un callback de LangChain arma el árbol de un turno a partir de lo que LangGraph
// informa: cada nodo como una cadena con su padre, cada llamada al modelo y cada herramienta. No toca los nodos.
//
// Lo que llega como cadena incluye piezas internas (`ChannelWrite`, `Branch`, `RunnableSequence`…). Se queda solo con
// los nodos (el nombre igual a `langgraph_node`) y con la raíz; el `LangGraph` de adentro de un subgrafo se funde con
// el nodo que lo contiene. Lo que cuelga de una pieza descartada pasa a colgar de su ancestro más cercano que quedó.

export type SpanKind = "turn" | "node" | "llm" | "tool";
export type SpanStatus = "ok" | "error" | "interrupted" | "running";

export interface TraceSpan {
  id: string;
  parentId?: string;
  kind: SpanKind;
  name: string;
  /** En milisegundos desde el inicio del turno. */
  start: number;
  /** Duración en milisegundos (sin terminar: hasta el final del turno). */
  duration: number;
  status: SpanStatus;
  error?: string;
  /** Llamada al modelo. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  /** Herramienta: los argumentos, el resultado (recortado) y cuántos reintentos hubo (fase 10). */
  args?: unknown;
  result?: string;
  retries?: number;
}

export type TurnKind = "new" | "edit" | "retry" | "continue" | "resume";
export type TraceStatus = "ok" | "awaiting" | "pending" | "error";

export interface Trace {
  id: string;
  threadId: string;
  kind: TurnKind;
  /** El mensaje de la persona que empezó el turno (si lo hubo: continuar o decidir no tienen). */
  input?: string;
  startedAt: string;
  durationMs: number;
  status: TraceStatus;
  error?: string;
  /** Las tareas del plan del router, en orden. */
  route: string[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  retries: number;
  /** Si es de una corrida de evaluación (fase 11, R9). */
  evalRunId?: string;
  evalCaseId?: string;
  spans: TraceSpan[];
}

/** Lo máximo que se guarda del resultado de una herramienta (R4). */
export const MAX_RESULT_CHARS = 2000;

const clip = (text: string) => (text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text);

function textOf(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && ToolMessage.isInstance(output as BaseMessage)) return (output as ToolMessage).text;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function parseArgs(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, MAX_RESULT_CHARS);
/** La pausa para una aprobación (fase 5) llega como un error del nodo, pero no es una falla. */
const isInterrupt = (error: unknown) => (error as Error)?.name === "GraphInterrupt";

interface OpenSpan extends Omit<TraceSpan, "start" | "duration"> {
  startedAt: number;
  endedAt?: number;
}

export class TraceRecorder extends BaseCallbackHandler {
  name = "trace_recorder";
  awaitHandlers = true;

  readonly id = randomUUID();
  private readonly startedAt: number;
  private readonly spans = new Map<string, OpenSpan>();
  /** Cada cadena descartada (o el `LangGraph` de un subgrafo), al paso que la reemplaza. */
  private readonly alias = new Map<string, string | undefined>();
  private rootId?: string;

  constructor(private readonly clock: () => number = Date.now) {
    super();
    this.startedAt = clock();
  }

  /** El paso que queda en el árbol para ese `runId` (él mismo, o su ancestro más cercano que quedó). */
  private resolve(runId?: string): string | undefined {
    let id = runId;
    for (let i = 0; id !== undefined && this.alias.has(id) && i < 1000; i++) id = this.alias.get(id);
    return id;
  }

  private open(span: Omit<OpenSpan, "startedAt" | "status">) {
    this.spans.set(span.id, { ...span, status: "running", startedAt: this.clock() });
  }

  private close(runId: string, status: SpanStatus, extra: Partial<OpenSpan> = {}) {
    const span = this.spans.get(runId);
    if (!span) return;
    Object.assign(span, extra, { status, endedAt: this.clock() });
  }

  handleChainStart(
    _chain: Serialized,
    _inputs: unknown,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ) {
    const parent = this.resolve(parentRunId);
    if (!parentRunId && !this.rootId) {
      this.rootId = runId;
      this.open({ id: runId, kind: "turn", name: "turno" });
      return;
    }
    // Un nodo de LangGraph se llama como su `langgraph_node`. El grafo de un subgrafo (`LangGraph`, adentro del nodo
    // `query_graph`) no, así que se funde con su nodo, igual que cualquier otra pieza interna con su padre.
    // Los nodos especiales (`__start__`) tampoco son pasos del turno.
    if (runName === undefined || runName !== metadata?.langgraph_node || runName.startsWith("__")) {
      this.alias.set(runId, parent);
      return;
    }
    this.open({ id: runId, parentId: parent, kind: "node", name: runName! });
  }

  handleChainEnd(_outputs: unknown, runId: string) {
    this.close(runId, "ok");
  }

  handleChainError(error: unknown, runId: string) {
    if (isInterrupt(error)) this.close(runId, "interrupted");
    else this.close(runId, "error", { error: errorText(error) });
  }

  handleChatModelStart(
    llm: Serialized,
    _messages: unknown,
    runId: string,
    parentRunId?: string,
    extra?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    const requested = metadata?.ls_model_name ?? (extra?.invocation_params as { model?: unknown } | undefined)?.model;
    const model = typeof requested === "string" && requested ? requested : undefined;
    this.open({ id: runId, parentId: this.resolve(parentRunId), kind: "llm", name: model ?? runName ?? String(llm?.id?.at(-1) ?? "modelo"), model });
  }

  handleLLMEnd(output: LLMResult, runId: string) {
    const span = this.spans.get(runId);
    if (!span) return;
    const message = (output.generations?.[0]?.[0] as { message?: BaseMessage } | undefined)?.message;
    const ai = message && AIMessage.isInstance(message) ? message : undefined;
    const model = String(ai?.response_metadata?.model ?? ai?.response_metadata?.model_name ?? output.llmOutput?.model ?? span.model ?? "desconocido");
    const inputTokens = ai?.usage_metadata?.input_tokens ?? 0;
    const outputTokens = ai?.usage_metadata?.output_tokens ?? 0;
    this.close(runId, "ok", { model, name: model, inputTokens, outputTokens, costUsd: estimateCostUsd(model, inputTokens, outputTokens) });
  }

  handleLLMError(error: unknown, runId: string) {
    this.close(runId, "error", { error: errorText(error) });
  }

  handleToolStart(_tool: Serialized, input: string, runId: string, parentRunId?: string, _tags?: string[], _metadata?: Record<string, unknown>, runName?: string) {
    this.open({ id: runId, parentId: this.resolve(parentRunId), kind: "tool", name: runName ?? "herramienta", args: parseArgs(input) });
  }

  handleToolEnd(output: unknown, runId: string) {
    // Un error que `safeTool` convierte en mensaje llega como fin con estado de error (fase 2).
    const failed = Boolean(output) && ToolMessage.isInstance(output as BaseMessage) && (output as ToolMessage).status === "error";
    const text = clip(textOf(output));
    this.close(runId, failed ? "error" : "ok", failed ? { result: text, error: text } : { result: text });
  }

  handleToolError(error: unknown, runId: string) {
    this.close(runId, "error", { error: errorText(error) });
  }

  /**
   * Un reintento que avisó una herramienta o una sección (fase 10, evento `retry`): se suma al paso que está corriendo
   * con ese nombre o, si ya terminó, al último con ese nombre. El aviso viaja por el stream y puede llegar cuando el
   * paso ya cerró. Las secciones del reporte se llaman `section:<sección>` y su nodo, `report_<sección>`.
   */
  noteRetry(target: string) {
    const name = target.startsWith("section:") ? `report_${target.slice("section:".length)}` : target;
    const candidates = [...this.spans.values()].reverse().filter((s) => s.name === name);
    const span = candidates.find((s) => s.status === "running") ?? candidates[0];
    if (span) span.retries = (span.retries ?? 0) + 1;
  }

  /** La traza del turno, con lo que se sabe al terminar. Los pasos que no terminaron quedan como «corriendo». */
  finish(meta: Pick<Trace, "threadId" | "kind" | "status" | "route"> & Partial<Pick<Trace, "input" | "error" | "evalRunId" | "evalCaseId">>): Trace {
    const end = this.clock();
    if (this.rootId) {
      const root = this.spans.get(this.rootId)!;
      // Cómo terminó el turno manda: LangGraph da por terminada la raíz también cuando se pausa o se corta.
      if (meta.status === "error") root.status = "error";
      else if (meta.status === "awaiting") root.status = "interrupted";
      else if (root.status === "running") root.status = "ok";
      root.endedAt ??= end;
      if (meta.error) root.error ??= meta.error;
    }
    const spans: TraceSpan[] = [...this.spans.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(({ startedAt, endedAt, ...span }) => ({ ...span, start: startedAt - this.startedAt, duration: (endedAt ?? end) - startedAt }));
    const llm = spans.filter((s) => s.kind === "llm");
    const costs = llm.map((s) => s.costUsd ?? null);
    return {
      id: this.id,
      threadId: meta.threadId,
      kind: meta.kind,
      ...(meta.input !== undefined && { input: meta.input }),
      startedAt: new Date(this.startedAt).toISOString(),
      durationMs: end - this.startedAt,
      status: meta.status,
      ...(meta.error && { error: meta.error }),
      route: meta.route,
      calls: llm.length,
      inputTokens: llm.reduce((n, s) => n + (s.inputTokens ?? 0), 0),
      outputTokens: llm.reduce((n, s) => n + (s.outputTokens ?? 0), 0),
      costUsd: costs.some((c) => c === null) ? null : costs.reduce<number>((n, c) => n + (c ?? 0), 0),
      retries: spans.reduce((n, s) => n + (s.retries ?? 0), 0),
      ...(meta.evalRunId && { evalRunId: meta.evalRunId }),
      ...(meta.evalCaseId && { evalCaseId: meta.evalCaseId }),
      spans,
    };
  }
}
