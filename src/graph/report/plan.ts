import { z } from "zod";
import { DEFAULT_PERIOD, periodSchema, type Period } from "./period.js";

// Lo que el modelo planificador devuelve. Es un esquema PLANO (un `kind` y campos opcionales) en vez de una unión:
// los modelos lo completan mejor. Después se convierte a un `Period` y se valida de verdad con `periodSchema`.

export const PERIOD_KINDS = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_days", "custom"] as const;

export const planOutputSchema = z.object({
  // `reason` primero: el modelo razona una frase antes de decidir.
  reason: z.string().describe("Una frase corta (hasta 15 palabras) con el motivo de la elección"),
  kind: z.enum(PERIOD_KINDS).describe("Forma del período"),
  n: z.number().int().optional().describe("Solo con last_days: cantidad de días, de 1 a 92"),
  dateFrom: z.string().optional().describe("Solo con custom: primer día, AAAA-MM-DD"),
  dateTo: z.string().optional().describe("Solo con custom: último día incluido, AAAA-MM-DD"),
});
export type PlanOutput = z.infer<typeof planOutputSchema>;

/** Convierte la salida del modelo en un período válido, o `undefined` si no se puede usar. */
export function toPeriod(output: unknown): Period | undefined {
  const parsed = planOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const { kind, n, dateFrom, dateTo } = parsed.data;
  const candidate =
    kind === "last_days" ? { kind, n } : kind === "custom" ? { kind, dateFrom, dateTo } : { kind };
  const period = periodSchema.safeParse(candidate);
  return period.success ? period.data : undefined;
}

export const PLAN_FALLBACK_NOTICE = "No pude interpretar el período del pedido; muestro la semana actual.";
export const defaultPeriod = (): Period => DEFAULT_PERIOD;
