// Lo que se ve en la página del chat (fase 9): un reductor puro, `applyEvent(estado, evento)`. Los componentes de
// React solo dibujan este estado. Este archivo lo usa el NAVEGADOR: solo importa tipos (nada de LangChain ni de la base).
import type { ApprovalRequest, HumanDecision } from "../graph/approval.js";
import type { Intent } from "../graph/intents.js";
import type { AgentNode } from "../graph/plan.js";
import type { Section } from "../graph/report/state.js";
import type { TurnResult } from "../graph/run-turn.js";
import type { ModelUsage } from "../graph/usage-tracker.js";
import type { Author, UiEvent } from "./events.js";
import type { ThreadView } from "./handlers.js";

export const AGENT_LABELS: Record<AgentNode, string> = {
  query_graph: "Consultas",
  action_graph: "Acciones",
  report_graph: "Reportes",
  chat: "Charla",
  clarify: "Aclaración",
  memory: "Memoria",
};

export const INTENT_LABELS: Record<Intent, string> = {
  query: "consulta",
  action: "acción",
  report: "reporte",
  chat: "charla",
  unclear: "aclaración",
  memory: "memoria",
};

/** Cómo se nombra cada herramienta de consulta en pantalla. */
export const TOOL_LABELS: Record<string, string> = {
  listAppointments: "Agenda de turnos",
  getSalesSummary: "Resumen de ventas",
  getStockLevels: "Stock de productos",
  findClient: "Búsqueda de clientes",
};

export const SECTION_LABELS: Record<Section, string> = { sales: "Ventas", appointments: "Turnos", stock: "Stock" };

/** Una parte de un turno, en el orden en que pasó. */
export type TurnPart =
  | { type: "route"; reason?: string; tasks: { intent: Intent; request: string }[] }
  | { type: "agent"; agent: AgentNode; status: "running" | "done" }
  | { type: "tool"; id: string; agent: AgentNode; name: string; args: Record<string, unknown>; status: "running" | "done" | "error" }
  /** Un texto del copiloto. `streaming`: todavía llegan tokens (es un borrador). */
  | { type: "text"; id: string; author: Author; kind: "reply" | "step" | "notice"; text: string; streaming: boolean }
  | { type: "action"; tool: string; ok: boolean; message: string }
  | { type: "section"; section: Section; status: "ok" | "error" }
  /** Lo que decidió la persona sobre una tarjeta (aprobar, rechazar o editar). */
  | { type: "decision"; text: string };

/** Lo que se ve en la conversación. */
export type ChatItem =
  | { kind: "human"; id: string; text: string }
  /** Un mensaje del copiloto leído del hilo guardado (al abrir o recargar la página). */
  | { kind: "history"; id: string; text: string; step: boolean }
  /** Un turno de esta sesión, con sus pasos en vivo. */
  | { kind: "turn"; id: string; parts: TurnPart[]; running: boolean; result?: TurnResult; error?: string };

export type PageStatus = "ready" | "running" | "awaiting" | "pending";

export interface PageState {
  threadId: string;
  status: PageStatus;
  items: ChatItem[];
  awaiting?: ApprovalRequest;
  /** Lo que gastó esta sesión de la página (se suma con cada turno). */
  session: ModelUsage[];
  /** Un error para mostrar arriba de la entrada (por ejemplo, un 409). */
  notice?: string;
}

/** El estado inicial, a partir del hilo guardado (`GET /api/threads/:id`). */
export function fromThreadView(view: ThreadView): PageState {
  return {
    threadId: view.threadId,
    status: view.status,
    items: view.messages.map((m) =>
      m.role === "human" ? { kind: "human", id: m.id, text: m.text } : { kind: "history", id: m.id, text: m.text, step: m.kind === "step" },
    ),
    ...(view.awaiting && { awaiting: view.awaiting }),
    session: [],
  };
}

let counter = 0;
const localId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** La persona manda un mensaje: se ve enseguida, con un turno nuevo en curso. */
export function startMessage(state: PageState, text: string): PageState {
  return {
    ...state,
    status: "running",
    notice: undefined,
    items: [...state.items, { kind: "human", id: localId("h"), text }, { kind: "turn", id: localId("t"), parts: [], running: true }],
  };
}

export function describeDecision(decision: HumanDecision): string {
  if (decision.decision === "approve") return "Aprobaste la acción.";
  if (decision.decision === "reject") return decision.comment ? `Rechazaste la acción: «${decision.comment}».` : "Rechazaste la acción.";
  return "Editaste la acción.";
}

/**
 * Sigue el turno que quedó en pausa o a medias (decidir sobre la tarjeta o «Continuar»): se agrega al último turno si
 * lo hay; si la página se acaba de abrir, empieza uno.
 */
export function startContinuation(state: PageState, decision?: HumanDecision): PageState {
  const items = [...state.items];
  const last = items.at(-1);
  const turn: Extract<ChatItem, { kind: "turn" }> =
    last?.kind === "turn" ? { ...last, running: true, error: undefined } : { kind: "turn", id: localId("t"), parts: [], running: true };
  if (decision) turn.parts = [...turn.parts, { type: "decision", text: describeDecision(decision) }];
  if (last?.kind === "turn") items[items.length - 1] = turn;
  else items.push(turn);
  return { ...state, status: "running", notice: undefined, items, awaiting: decision ? undefined : state.awaiting };
}

function addUsage(session: ModelUsage[], usage: ModelUsage[]): ModelUsage[] {
  const merged = new Map(session.map((u) => [u.model, { ...u }]));
  for (const u of usage) {
    const entry = merged.get(u.model) ?? { model: u.model, calls: 0, inputTokens: 0, outputTokens: 0 };
    entry.calls += u.calls;
    entry.inputTokens += u.inputTokens;
    entry.outputTokens += u.outputTokens;
    merged.set(u.model, entry);
  }
  return [...merged.values()];
}

function updateTurn(state: PageState, update: (turn: Extract<ChatItem, { kind: "turn" }>) => Extract<ChatItem, { kind: "turn" }>): PageState {
  const index = state.items.findLastIndex((i) => i.kind === "turn");
  if (index === -1) return state;
  const items = [...state.items];
  items[index] = update(items[index] as Extract<ChatItem, { kind: "turn" }>);
  return { ...state, items };
}

function applyToParts(parts: TurnPart[], event: UiEvent): TurnPart[] {
  switch (event.type) {
    case "route":
      return [...parts, { type: "route", ...(event.reason && { reason: event.reason }), tasks: event.tasks }];
    case "agent": {
      if (event.status === "start") return [...parts, { type: "agent", agent: event.agent, status: "running" }];
      const at = parts.findLastIndex((p) => p.type === "agent" && p.agent === event.agent && p.status === "running");
      if (at === -1) return parts;
      const next = [...parts];
      next[at] = { type: "agent", agent: event.agent, status: "done" };
      return next;
    }
    case "token": {
      const at = parts.findIndex((p) => p.type === "text" && p.id === event.messageId);
      if (at === -1) return [...parts, { type: "text", id: event.messageId, author: event.agent, kind: "reply", text: event.text, streaming: true }];
      const part = parts[at] as Extract<TurnPart, { type: "text" }>;
      const next = [...parts];
      next[at] = { ...part, text: part.text + event.text };
      return next;
    }
    case "message": {
      // El texto guardado reemplaza al borrador de tokens con el mismo id (lo que queda es lo que quedó en el hilo).
      const text: TurnPart = { type: "text", id: event.id, author: event.author, kind: event.kind, text: event.text, streaming: false };
      const at = parts.findIndex((p) => p.type === "text" && p.id === event.id);
      if (at === -1) return [...parts, text];
      const next = [...parts];
      next[at] = text;
      return next;
    }
    case "tool_start":
      return [...parts, { type: "tool", id: event.id, agent: event.agent, name: event.name, args: event.args, status: "running" }];
    case "tool_end":
      return parts.map((p) => (p.type === "tool" && p.id === event.id ? { ...p, status: event.ok ? "done" : "error" } : p));
    case "action_result":
      return [...parts, { type: "action", tool: event.tool, ok: event.ok, message: event.message }];
    case "report_section":
      return [...parts, { type: "section", section: event.section, status: event.status }];
    default:
      return parts;
  }
}

/** Aplica un evento del servidor al estado de la página. */
export function applyEvent(state: PageState, event: UiEvent): PageState {
  switch (event.type) {
    case "approval":
      return { ...state, status: "awaiting", awaiting: event.request };
    case "done": {
      const result = event.result;
      const next = updateTurn(state, (turn) => ({
        ...turn,
        running: false,
        result,
        // Un borrador que nunca recibió su mensaje final (no debería pasar) deja de parpadear.
        parts: turn.parts.map((p) => (p.type === "text" && p.streaming ? { ...p, streaming: false } : p)),
      }));
      return {
        ...next,
        status: result.awaiting ? "awaiting" : "ready",
        ...(result.awaiting ? { awaiting: result.awaiting } : { awaiting: undefined }),
        session: addUsage(state.session, result.summary.usage),
      };
    }
    case "error": {
      const next = updateTurn(state, (turn) => ({
        ...turn,
        running: false,
        error: event.message,
        parts: turn.parts.map((p) => (p.type === "agent" && p.status === "running" ? { ...p, status: "done" } : p.type === "tool" && p.status === "running" ? { ...p, status: "error" } : p.type === "text" && p.streaming ? { ...p, streaming: false } : p)),
      }));
      return { ...next, status: event.pending ? "pending" : "ready" };
    }
    default:
      return updateTurn(state, (turn) => ({ ...turn, parts: applyToParts(turn.parts, event) }));
  }
}

/** Si la conexión se cortó sin `done` ni `error` (por ejemplo, se cayó el servidor): el turno queda a medias. */
export function connectionLost(state: PageState): PageState {
  if (state.status !== "running") return state;
  return applyEvent(state, { type: "error", message: "Se cortó la conexión con el servidor. Si el turno quedó a medias, podés continuarlo.", pending: true });
}

/** Texto corto de una herramienta con sus argumentos, para la línea del paso. */
export function describeTool(name: string, args: Record<string, unknown>): { title: string; detail: string } {
  const detail = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
  return { title: TOOL_LABELS[name] ?? name, detail };
}
