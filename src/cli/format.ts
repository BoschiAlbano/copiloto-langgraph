import { estimateCostUsd } from "../config/pricing.js";
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

/** Resumen de una línea de todo el uso. */
export function describeUsageTotal(usage: ModelUsage[]): string {
  const t = totalUsage(usage);
  return `${t.calls} llamada(s) al modelo · entrada ${number(t.inputTokens)} · salida ${number(t.outputTokens)} tokens · ${usd(costOfUsage(usage))}`;
}
