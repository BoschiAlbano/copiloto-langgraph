import { z } from "zod";
import { localDateTimeToUtc, localMinutesOfDay, localWeekday } from "../dates.js";
import { normalize } from "../text.js";
import { ToolUserError } from "../safe.js";

// Reglas del negocio de las acciones (fase 5). Se comprueban al proponer y otra vez al ejecutar.

/** La barbería abre de lunes a sábado, de 10:00 a 20:00 (hora de Argentina). */
export const OPEN_MINUTE = 10 * 60;
export const CLOSE_MINUTE = 20 * 60;
export const SLOT_MINUTES = 15;
export const CLOSED_WEEKDAY = 0; // domingo

/** Un ajuste de stock grande se marca como de riesgo alto. */
export const HIGH_RISK_STOCK_DELTA = 100;

export const PAYMENT_LABELS = { cash: "efectivo", card: "tarjeta", transfer: "transferencia" } as const;

/**
 * Horario de un turno: día y hora locales + duración → instantes de inicio y fin, o ToolUserError si el negocio
 * no lo permite (domingo, fuera de horario, no múltiplo de 15 minutos, ya pasó). Es una función pura: se usa
 * al proponer y otra vez al ejecutar.
 */
export function checkAppointmentSlot(date: string, time: string, durationMin: number, serviceName: string, now: Date) {
  if (localWeekday(date) === CLOSED_WEEKDAY) throw new ToolUserError("La barbería no abre los domingos.");
  const startsAt = localDateTimeToUtc(date, time);
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
  const startMinute = localMinutesOfDay(startsAt);
  if (startMinute % SLOT_MINUTES !== 0) {
    throw new ToolUserError(`Los turnos empiezan en múltiplos de ${SLOT_MINUTES} minutos (por ejemplo 15:00 o 15:15).`);
  }
  if (startMinute < OPEN_MINUTE || startMinute + durationMin > CLOSE_MINUTE) {
    throw new ToolUserError(
      `Los turnos son entre las 10:00 y las 20:00, y ${serviceName} dura ${durationMin} minutos: tiene que terminar antes del cierre.`,
    );
  }
  if (startsAt.getTime() <= now.getTime()) throw new ToolUserError("Ese horario ya pasó. Elegí uno futuro.");
  return { startsAt, endsAt };
}

/** Errores de Zod como texto legible, para el modelo y para la persona que edita. */
export function describeZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ");
}

/** Elige un elemento por nombre (sin acentos ni mayúsculas): primero coincidencia exacta, después parcial única. */
export function resolveByName<T extends { name: string }>(items: T[], wanted: string, label: string): T {
  const target = normalize(wanted.trim());
  const exact = items.filter((i) => normalize(i.name) === target);
  if (exact.length === 1) return exact[0]!;
  const partial = items.filter((i) => normalize(i.name).includes(target));
  if (partial.length === 1) return partial[0]!;
  const options = items.map((i) => i.name).join(", ");
  if (partial.length === 0) throw new ToolUserError(`No hay ${label} que coincida con "${wanted}". Opciones: ${options}.`);
  throw new ToolUserError(`"${wanted}" coincide con más de un ${label}: ${partial.map((i) => i.name).join(", ")}. Indicá cuál.`);
}

/** Pesos argentinos enteros con separador de miles, por ejemplo `$ 19.000`. */
export const money = (amount: number) => `$ ${amount.toLocaleString("es-AR")}`;
