import { estimateCostUsd } from "@copilot/config/pricing"
import type { ModelUsage } from "@copilot/graph/usage-tracker"

const number = new Intl.NumberFormat("es-AR")

/** Costo estimado en dólares, o null si algún modelo no tiene precio conocido. */
export function costOf(usage: ModelUsage[]): number | null {
  let total = 0
  for (const u of usage) {
    const cost = estimateCostUsd(u.model, u.inputTokens, u.outputTokens)
    if (cost === null) return null
    total += cost
  }
  return total
}

export const usd = (value: number | null) =>
  value === null ? "costo desconocido" : `US$ ${value.toLocaleString("es-AR", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`

export const tokens = (n: number) => number.format(n)

export function totals(usage: ModelUsage[]) {
  return usage.reduce((t, u) => ({ calls: t.calls + u.calls, input: t.input + u.inputTokens, output: t.output + u.outputTokens }), { calls: 0, input: 0, output: 0 })
}

/** «hace 5 min», «ayer», «3 nov». */
export function since(date: Date | string, now = new Date()): string {
  const d = typeof date === "string" ? new Date(date) : date
  const minutes = Math.round((now.getTime() - d.getTime()) / 60_000)
  if (minutes < 1) return "recién"
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  if (hours < 48) return "ayer"
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "short" })
}

/** Un valor de un parámetro, como se lee en la tarjeta. */
export const paramValue = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value))
