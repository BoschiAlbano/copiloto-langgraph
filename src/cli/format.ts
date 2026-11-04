import { estimateCostUsd } from "../config/pricing.js";
import type { ApprovalRequest } from "../graph/approval.js";
import type { TurnResult } from "../graph/run-turn.js";
import type { CheckpointInfo, ThreadSummary } from "../graph/threads.js";
import type { AgentNode } from "../graph/plan.js";
import type { Memory } from "../memory/store.js";
import type { ActionResult } from "../graph/usage.js";
import { costOfUsage, totalUsage, type ModelUsage } from "../graph/usage-tracker.js";

export const number = (n: number) => n.toLocaleString("es-AR");
export const usd = (n: number | null, decimals = 4) => (n === null ? "s/d" : `US$ ${n.toFixed(decimals).replace(".", ",")}`);

/** Una línea por modelo: llamadas, tokens y costo estimado. */
export function describeUsagePerModel(usage: ModelUsage[]): string[] {
  return usage.map(
    (u) =>
      `${u.model}: ${u.calls} llamada(s) · entrada ${number(u.inputTokens)} · salida ${number(u.outputTokens)} · ` +
      usd(estimateCostUsd(u.model, u.inputTokens, u.outputTokens)),
  );
}

/** Fecha y hora en horario argentino, como las ve quien opera el negocio. */
export function formatWhen(date: Date | string | undefined): string {
  if (!date) return "s/d";
  return new Date(date).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Una línea por hilo para `npm run threads`. */
export function describeThread(t: ThreadSummary): string {
  const flag = t.awaiting ? " ⏸ espera tu aprobación" : t.pending ? " ⚠ a medias" : "";
  return `${t.threadId.padEnd(14)} ${formatWhen(t.lastActivity)}  ${String(t.messageCount).padStart(3)} msj  "${t.firstMessage}"${flag}`;
}

/**
 * La ruta del turno (fase 7). Con una sola tarea, como antes: `[ruta] query: motivo`. Con varias, el orden en que se
 * hacen y la parte del pedido de cada una: `[ruta] action → query: motivo` y debajo una línea por tarea.
 */
export function describeRoute(route: TurnResult["route"]): string[] {
  if (!route.intent) return [];
  const tasks = route.tasks ?? [];
  const head = tasks.length > 1 ? tasks.map((t) => t.intent).join(" → ") : route.intent;
  const lines = [`[ruta] ${head}: ${route.reason ?? "sin motivo"}`];
  if (tasks.length > 1) tasks.forEach((t, i) => lines.push(`       ${i + 1}. ${t.intent}: ${t.request}`));
  return lines;
}

/** Una línea por checkpoint para `npm run threads -- history <id>`. */
export function describeCheckpoint(c: CheckpointInfo): string {
  const ran = c.ranNodes.length ? c.ranNodes.join("+") : "—";
  const next = c.next.length ? c.next.join("+") : "fin";
  const route = c.intent ? ` · ruta ${c.intent}` : "";
  return `${String(c.step).padStart(3)}  ${c.source.padEnd(6)} corrió ${ran.padEnd(12)} sigue ${next.padEnd(12)} ${String(c.messageCount).padStart(2)} msj${route}  ${c.checkpointId.slice(0, 8)}`;
}

const RISK_LABELS = { low: "bajo", medium: "medio", high: "alto" } as const;

/**
 * La tarjeta de aprobación en texto. Todo sale del estado guardado y de lo que armó el código: el texto
 * que escribió el modelo no se usa.
 */
export function describeCard(request: ApprovalRequest): string[] {
  const { action, error, edited } = request;
  return [
    ...(error ? [`  ⚠ ${error}`, "  La propuesta anterior SIGUE pendiente: no se aprobó ni se cambió nada.", ""] : []),
    ...(edited ? ["  ✎ Editaste la propuesta. TODAVÍA NO SE EJECUTÓ NADA: revisala y aprobala con «s».", ""] : []),
    `  ┌─ ${edited ? "Acción propuesta (editada)" : "Acción propuesta"} · riesgo ${RISK_LABELS[action.risk]}`,
    `  │ ${action.summary}`,
    `  │ ${action.tool} ${JSON.stringify(action.params)}`,
    ...(action.originalParams ? [`  │ (el copiloto había propuesto: ${JSON.stringify(action.originalParams)})`] : []),
    "  └─ ¿La aprobás?  [s] sí  ·  [n] no (podés escribir un motivo: «n porque …»)  ·  [e] editar los parámetros",
  ];
}

const SECTION_NAMES = { sales: "ventas", appointments: "turnos", stock: "stock" } as const;

/** Línea de la terminal con el período de un reporte y cómo salió cada sección: `semana del 26/10 al 01/11 · ventas ✔ · turnos ✔ · stock ✖`. */
export function describeReportStatus(report: NonNullable<TurnResult["report"]>): string {
  const sections = (Object.keys(SECTION_NAMES) as (keyof typeof SECTION_NAMES)[])
    .map((s) => `${SECTION_NAMES[s]} ${report.sections[s] === "ok" ? "✔" : "✖"}`)
    .join(" · ");
  return `[reporte] ${report.label} · ${sections}`;
}

/** Línea con el resultado de una acción decidida, armada por el código. */
export function describeActionResult(result: ActionResult): string {
  return `  [acción] ${result.ok ? "✔" : "✖"} ${result.message}`;
}

/** Interpreta lo que escribió la persona ante la tarjeta. `null` si no se entiende. */
export function parseDecisionInput(input: string): { decision: "approve" } | { decision: "reject"; comment?: string } | { decision: "edit" } | null {
  const text = input.trim();
  const lower = text.toLowerCase();
  if (["s", "si", "sí", "aprobar", "ok"].includes(lower)) return { decision: "approve" };
  if (["e", "editar"].includes(lower)) return { decision: "edit" };
  const reject = /^(n|no|rechazar)(?:\s+(.*))?$/i.exec(text);
  if (reject) {
    const comment = reject[2]?.replace(/^porque\s+/i, "").trim().slice(0, 200);
    return comment ? { decision: "reject", comment } : { decision: "reject" };
  }
  return null;
}

/**
 * ¿Lo que escribió la persona ante la tarjeta parece una edición (un objeto JSON o `clave=valor`)? Pegar el JSON
 * editado directo en el «¿Aprobás?» es lo natural: se trata como edición, no como una respuesta desconocida.
 */
export const looksLikeEdit = (input: string) => /^\s*\{/.test(input) || /^\s*[A-Za-z_]\w*\s*=/.test(input);

export type EditParse = { ok: true; params: Record<string, unknown> } | { ok: false; error: string };

/** `50` → 50, `true` → true, `"hola"` → "hola", `Llegó un pedido` → texto tal cual. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Lo que escribió la persona al editar: un objeto JSON completo, o uno o más cambios `clave=valor` separados por
 * `;` que se aplican sobre los parámetros actuales (por ejemplo `delta=50` o `delta=50; reason=Llegaron 50`).
 * Es solo la lectura del renglón: las reglas del negocio las valida después el grafo.
 */
export function parseEditInput(input: string, current: Record<string, unknown>): EditParse {
  const text = input.trim();
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, error: "tiene que ser un objeto JSON" };
      return { ok: true, params: parsed as Record<string, unknown> };
    } catch (error) {
      return { ok: false, error: `no es un JSON válido (${(error as Error).message})` };
    }
  }

  const changes: Record<string, unknown> = {};
  for (const part of text.split(";")) {
    const pair = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/s.exec(part);
    if (!pair) return { ok: false, error: `no entendí «${part.trim()}»; escribí clave=valor (por ejemplo delta=50) o un objeto JSON` };
    const [, key, value] = pair;
    if (!(key! in current)) return { ok: false, error: `«${key}» no es un parámetro de esta acción (${Object.keys(current).join(", ")})` };
    changes[key!] = parseValue(value!);
  }
  return { ok: true, params: { ...current, ...changes } };
}

/** Resumen de una línea de todo el uso. */
export function describeUsageTotal(usage: ModelUsage[]): string {
  const t = totalUsage(usage);
  return `${t.calls} llamada(s) al modelo · entrada ${number(t.inputTokens)} · salida ${number(t.outputTokens)} tokens · ${usd(costOfUsage(usage))}`;
}

const MEMORY_KIND_LABELS = { rule: "regla", preference: "preferencia" } as const;

/** Una memoria por renglón para `npm run memory`: id, tipo, cuándo se anotó y el texto. */
export function describeMemoryRow(m: Pick<Memory, "id" | "kind" | "text" | "createdAt">): string {
  return `${m.id}  ${MEMORY_KIND_LABELS[m.kind].padEnd(11)}  ${formatWhen(m.createdAt).padEnd(12)}  ${m.text}`;
}

/** La línea de la memoria en el chat (fase 8): cuántas memorias había en contexto en este turno. */
export function describeMemoryStatus(count: number): string {
  return `[memoria] ${count === 1 ? "1 en contexto" : `${count} en contexto`}`;
}

/** Cómo se llama cada agente en la terminal. */
export const AGENT_LABELS: Record<AgentNode, string> = {
  query_graph: "consultas",
  action_graph: "acciones",
  report_graph: "reportes",
  chat: "charla",
  clarify: "aclaración",
  memory: "memoria",
};

const usageBrief = (usage: ModelUsage[]) => {
  const t = totalUsage(usage);
  return `${t.calls} llamada(s) · ${number(t.inputTokens)} / ${number(t.outputTokens)} tokens · ${usd(costOfUsage(usage))}`;
};

/**
 * Los agentes que intervinieron en el turno (fase 7): una línea con el orden y una por agente, con sus herramientas,
 * llamadas, tokens (entrada / salida) y costo. El router va aparte, como coordinación. Vacío si no hubo llamadas al
 * modelo (por ejemplo, con modelos falsos en los tests).
 */
export function describeAgents(turn: Pick<TurnResult, "agents" | "coordination">): string[] {
  if (turn.agents.length === 0 && turn.coordination.length === 0) return [];
  const order = turn.agents.map((a) => AGENT_LABELS[a.agent]).join(" → ") || "ninguno";
  const lines = [`[agentes] ${order}`];
  if (turn.coordination.length) lines.push(`          coordinación (router): ${usageBrief(turn.coordination)}`);
  turn.agents.forEach((a, i) => {
    const tools = a.tools.length ? `${a.tools.join(", ")} · ` : "";
    const waiting = a.waiting ? " · ⏸ espera tu decisión" : "";
    lines.push(`          ${turn.agents.length > 1 ? `${i + 1}. ` : ""}${AGENT_LABELS[a.agent]}: ${tools}${usageBrief(a.usage)}${waiting}`);
  });
  return lines;
}
