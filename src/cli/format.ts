import { estimateCostUsd } from "../config/pricing.js";
import type { CheckpointInfo, ThreadSummary } from "../graph/threads.js";
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
  const flag = t.pending ? " ⚠ a medias" : "";
  return `${t.threadId.padEnd(14)} ${formatWhen(t.lastActivity)}  ${String(t.messageCount).padStart(3)} msj  "${t.firstMessage}"${flag}`;
}

/** Una línea por checkpoint para `npm run threads -- history <id>`. */
export function describeCheckpoint(c: CheckpointInfo): string {
  const ran = c.ranNodes.length ? c.ranNodes.join("+") : "—";
  const next = c.next.length ? c.next.join("+") : "fin";
  const route = c.intent ? ` · ruta ${c.intent}` : "";
  return `${String(c.step).padStart(3)}  ${c.source.padEnd(6)} corrió ${ran.padEnd(12)} sigue ${next.padEnd(12)} ${String(c.messageCount).padStart(2)} msj${route}  ${c.checkpointId.slice(0, 8)}`;
}

/** Resumen de una línea de todo el uso. */
export function describeUsageTotal(usage: ModelUsage[]): string {
  const t = totalUsage(usage);
  return `${t.calls} llamada(s) al modelo · entrada ${number(t.inputTokens)} · salida ${number(t.outputTokens)} tokens · ${usd(costOfUsage(usage))}`;
}
