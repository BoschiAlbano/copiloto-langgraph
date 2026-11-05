// Lo que se ve de una traza en la web (fase 11, R5): funciones puras, sin LangChain ni la base. Las usan las páginas
// `/traces` y `/traces/:id`.
import type { SpanKind, SpanStatus, Trace, TraceStatus, TurnKind } from "../observability/trace-recorder.js";
import type { TraceSpan } from "../observability/trace-recorder.js";

export const TURN_KIND_LABELS: Record<TurnKind, string> = {
  new: "Mensaje",
  edit: "Editado",
  retry: "Reintento",
  continue: "Continuación",
  resume: "Decisión",
};

export const TRACE_STATUS_LABELS: Record<TraceStatus, string> = {
  ok: "Terminó",
  awaiting: "Esperó una decisión",
  pending: "Quedó a medias",
  error: "Con error",
};

export const SPAN_KIND_LABELS: Record<SpanKind, string> = { turn: "Turno", node: "Nodo", llm: "Modelo", tool: "Herramienta" };
export const SPAN_STATUS_LABELS: Record<SpanStatus, string> = { ok: "bien", error: "con error", interrupted: "en pausa", running: "sin terminar" };

/** «840 ms», «3,1 s», «1 min 12 s». */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString("es-AR", { maximumFractionDigits: 1 })} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Una fila de la línea de tiempo: el paso, su sangría y dónde va su barra (en % del turno). */
export interface TimelineRow {
  span: TraceSpan;
  depth: number;
  offsetPct: number;
  widthPct: number;
  /** Lo que se lee en la fila, además del nombre: tokens, reintentos o el error. */
  detail?: string;
}

/** El ancho mínimo de una barra, para que un paso de 1 ms se vea igual. */
const MIN_WIDTH_PCT = 0.6;

function detailOf(span: TraceSpan): string | undefined {
  if (span.kind === "llm") return `${span.inputTokens ?? 0} → ${span.outputTokens ?? 0} tokens`;
  if (span.retries) return `${span.retries} ${span.retries === 1 ? "reintento" : "reintentos"}`;
  return undefined;
}

/**
 * El árbol de la traza como filas, en orden: cada paso y, debajo, sus hijos por orden de inicio. La raíz (el turno)
 * va primero. Un paso cuyo padre no está (no debería pasar) cuelga de la raíz, en vez de perderse.
 */
export function timelineRows(trace: Pick<Trace, "spans" | "durationMs">): TimelineRow[] {
  const spans = trace.spans;
  if (spans.length === 0) return [];
  const total = Math.max(trace.durationMs, ...spans.map((s) => s.start + s.duration), 1);
  const ids = new Set(spans.map((s) => s.id));
  const root = spans.find((s) => s.kind === "turn") ?? spans[0]!;
  const children = new Map<string | undefined, TraceSpan[]>();
  for (const span of spans) {
    if (span === root) continue;
    const parent = span.parentId && ids.has(span.parentId) ? span.parentId : root.id;
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  const rows: TimelineRow[] = [];
  const visit = (span: TraceSpan, depth: number) => {
    const offsetPct = (span.start / total) * 100;
    const widthPct = Math.min(Math.max((span.duration / total) * 100, MIN_WIDTH_PCT), 100 - offsetPct);
    const detail = detailOf(span);
    rows.push({ span, depth, offsetPct, widthPct, ...(detail && { detail }) });
    for (const child of [...(children.get(span.id) ?? [])].sort((a, b) => a.start - b.start)) visit(child, depth + 1);
  };
  visit(root, 0);
  return rows;
}

/** El resultado o los argumentos de un paso, legibles: un JSON se muestra con sangría. */
export function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}
