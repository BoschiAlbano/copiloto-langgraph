import { z } from "zod";

// El negocio está en Argentina: UTC-3 todo el año (sin horario de verano).
const ART_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;
const TIME_ZONE = "America/Argentina/Buenos_Aires";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Mediodía UTC del día indicado, o null si no existe (por ejemplo 2026-02-30). */
function parseDay(value: string): number | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  const valid = check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d;
  return valid ? ms : null;
}

/** `YYYY-MM-DD` real, interpretado como día local de Argentina. */
export const localDateSchema = z
  .string()
  .regex(DATE_RE, "Usá el formato YYYY-MM-DD")
  .refine((v) => parseDay(v) !== null, "La fecha no existe");

/** Cantidad de días que abarca el rango, ambos extremos incluidos. */
export function daysInRange(dateFrom: string, dateTo: string): number {
  return (parseDay(dateTo)! - parseDay(dateFrom)!) / DAY_MS + 1;
}

/**
 * Rango [from, toExclusive) en UTC que cubre desde el inicio del día local `dateFrom`
 * hasta el final del día local `dateTo` (ambos inclusive).
 */
export function localDayRangeUtc(dateFrom: string, dateTo: string) {
  const from = parseDay(dateFrom);
  const to = parseDay(dateTo);
  if (from === null || to === null) throw new Error("Fecha inválida");
  return {
    from: new Date(from + ART_OFFSET_MS),
    toExclusive: new Date(to + DAY_MS + ART_OFFSET_MS),
  };
}

/** Instante → texto ISO con la hora de Argentina, por ejemplo `2026-10-28T10:00:00-03:00`. */
export function formatLocal(date: Date): string {
  return new Date(date.getTime() - ART_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

/** El día local de Argentina de un instante, como `YYYY-MM-DD`. */
export function localDateOf(date: Date): string {
  return new Date(date.getTime() - ART_OFFSET_MS).toISOString().slice(0, 10);
}

/** Texto para el prompt del sistema, por ejemplo `martes 27 de octubre de 2026, 15:00 (hora de Argentina)`. */
export function describeNow(now: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("es-AR", {
      timeZone: TIME_ZONE,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.day} de ${parts.month} de ${parts.year}, ${parts.hour}:${parts.minute} (hora de Argentina)`;
}
