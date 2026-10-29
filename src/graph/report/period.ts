import { z } from "zod";
import { localDateOf, localDateSchema, localWeekday } from "../../tools/dates.js";

// El período de un reporte. El modelo NO hace cuentas de calendario: elige una forma simbólica ("esta semana",
// "el mes pasado", "los últimos 30 días") y este módulo calcula las fechas con el reloj, en horario de Argentina.

export const MAX_PERIOD_DAYS = 366;
export const MAX_LAST_DAYS = 92;

export const periodSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("today") }),
  z.strictObject({ kind: z.literal("yesterday") }),
  z.strictObject({ kind: z.literal("this_week") }),
  z.strictObject({ kind: z.literal("last_week") }),
  z.strictObject({ kind: z.literal("this_month") }),
  z.strictObject({ kind: z.literal("last_month") }),
  z.strictObject({ kind: z.literal("last_days"), n: z.number().int().min(1).max(MAX_LAST_DAYS) }),
  z.strictObject({ kind: z.literal("custom"), dateFrom: localDateSchema, dateTo: localDateSchema }),
]);
export type Period = z.infer<typeof periodSchema>;

/** Lo que se usa cuando no se pide un período, o cuando el pedido no se pudo interpretar. */
export const DEFAULT_PERIOD: Period = { kind: "this_week" };

export interface ResolvedPeriod {
  /** Primer día, `YYYY-MM-DD` (hora de Argentina). */
  dateFrom: string;
  /** Último día incluido, `YYYY-MM-DD`. */
  dateTo: string;
  /** Texto para el título del reporte, por ejemplo «semana del 26/10 al 01/11». */
  label: string;
}

/** Un período que no se puede usar (por ejemplo, `custom` al revés o de más de un año). */
export class PeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeriodError";
  }
}

const DAY_MS = 86_400_000;
// Mediodía UTC del día: nunca cae en el borde de un cambio de día, sin importar la zona.
const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
const addDays = (iso: string, n: number) => at(iso).getTime() + n * DAY_MS;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"] as const;

/** `26/10` (o `26/10/2025` si el año no es el actual). */
function short(day: string, currentYear: string): string {
  const [y, m, d] = day.split("-");
  return y === currentYear ? `${d}/${m}` : `${d}/${m}/${y}`;
}

const monthOf = (day: string) => day.slice(0, 7); // YYYY-MM
const firstOfMonth = (month: string) => `${month}-01`;
function lastOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return iso(Date.UTC(y!, m!, 0, 12)); // el día 0 del mes siguiente es el último de este
}
const previousMonth = (month: string) => monthOf(iso(addDays(firstOfMonth(month), -1)));
const monthName = (month: string) => `${MONTHS[Number(month.slice(5)) - 1]} de ${month.slice(0, 4)}`;

/** Lunes de la semana de `day` (la semana va de lunes a domingo). */
const mondayOf = (day: string) => iso(addDays(day, -((localWeekday(day) + 6) % 7)));

/** Convierte un período simbólico en fechas. `now` es el reloj; las fechas son siempre de Argentina. */
export function resolvePeriod(period: Period, now: Date = new Date()): ResolvedPeriod {
  const today = localDateOf(now);
  const year = today.slice(0, 4);
  const range = (dateFrom: string, dateTo: string, label: string): ResolvedPeriod => ({ dateFrom, dateTo, label });
  const between = (dateFrom: string, dateTo: string) => `del ${short(dateFrom, year)} al ${short(dateTo, year)}`;
  const dayLabel = (day: string) => `${WEEKDAYS[localWeekday(day)]} ${short(day, year)}`;

  switch (period.kind) {
    case "today":
      return range(today, today, `hoy, ${dayLabel(today)}`);
    case "yesterday": {
      const day = iso(addDays(today, -1));
      return range(day, day, `ayer, ${dayLabel(day)}`);
    }
    case "this_week": {
      const monday = mondayOf(today);
      const sunday = iso(addDays(monday, 6));
      return range(monday, sunday, `semana ${between(monday, sunday)}`);
    }
    case "last_week": {
      const monday = iso(addDays(mondayOf(today), -7));
      const sunday = iso(addDays(monday, 6));
      return range(monday, sunday, `semana pasada, ${between(monday, sunday)}`);
    }
    case "this_month": {
      const month = monthOf(today);
      return range(firstOfMonth(month), lastOfMonth(month), monthName(month));
    }
    case "last_month": {
      const month = previousMonth(monthOf(today));
      return range(firstOfMonth(month), lastOfMonth(month), monthName(month));
    }
    case "last_days": {
      if (period.n === 1) return range(today, today, `hoy, ${dayLabel(today)}`);
      const dateFrom = iso(addDays(today, -(period.n - 1)));
      return range(dateFrom, today, `últimos ${period.n} días, ${between(dateFrom, today)}`);
    }
    case "custom": {
      if (period.dateFrom > period.dateTo) throw new PeriodError("La fecha de inicio es posterior a la de fin.");
      const days = (at(period.dateTo).getTime() - at(period.dateFrom).getTime()) / DAY_MS + 1;
      if (days > MAX_PERIOD_DAYS) throw new PeriodError(`El período no puede superar ${MAX_PERIOD_DAYS} días.`);
      return range(period.dateFrom, period.dateTo, between(period.dateFrom, period.dateTo));
    }
  }
}

/** Cantidad de días del período, ambos extremos incluidos. */
export function periodDays({ dateFrom, dateTo }: Pick<ResolvedPeriod, "dateFrom" | "dateTo">): number {
  return (at(dateTo).getTime() - at(dateFrom).getTime()) / DAY_MS + 1;
}
