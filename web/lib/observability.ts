import type { TraceStatus } from "@copilot/observability/trace-recorder"
import { TRACE_STATUS_LABELS } from "@copilot/web/trace-view"

// Formato de las páginas de observabilidad (fase 11). Las páginas se dibujan en el servidor: una fecha absoluta, en la
// hora del negocio, sale igual siempre (no hay «hace 5 min» que cambie entre el servidor y el navegador).

const dateTime = new Intl.DateTimeFormat("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})

export const when = (iso: string) => dateTime.format(new Date(iso))

export function statusBadge(status: TraceStatus): { label: string; variant: "secondary" | "outline" | "destructive" } {
  return {
    label: TRACE_STATUS_LABELS[status],
    variant: status === "error" ? "destructive" : status === "ok" ? "secondary" : "outline",
  }
}
