import { localDateOf } from "../src/tools/dates.js";

// Escenarios congelados de la fase 5 (ver specs/fase-05-aprobacion-humana.md). Se escribieron ANTES del
// prompt de la rama de acciones y ninguna de estas frases aparece en `action.md` (lo verifica un test).
// Solo proponen y rechazan: nunca aprueban. Las fechas salen del día en que se corre.

/** Datos de prueba que crea el test con el dueño y borra al terminar. */
export const FIXTURES = {
  /** Cliente con un único turno futuro (E2). */
  singleAppointmentClient: "Pruebas Fase Cinco",
  /** Cliente con dos turnos futuros (E5). */
  doubleAppointmentClient: "Doble Turno Pruebas",
} as const;

/**
 * Horas locales de los turnos de prueba: después del cierre (20:00), para no chocar con la agenda sembrada.
 * E5 exige que la respuesta mencione las dos: si no las nombra, no encontró los turnos y la pregunta no sirve.
 */
export const FIXTURE_TIMES = { single: "20:15", double: ["20:30", "20:45"] } as const;

export type ExpectedProposal =
  | {
      kind: "propose";
      tool: "createAppointment" | "cancelAppointment" | "registerSale" | "adjustStock";
      /** Campos que deben coincidir en los parámetros de la propuesta. */
      params: Record<string, unknown>;
    }
  | { kind: "ask" } // no propone nada: pregunta
  | { kind: "propose-only"; tool: "createAppointment"; params: Record<string, unknown> }; // E6: y nada más

export interface ActionCase {
  id: "E1" | "E2" | "E3" | "E4" | "E5" | "E6";
  /** Si el escenario nunca puede fallar (CA11). */
  critical: boolean;
  message: string;
  expected: ExpectedProposal;
}

const DAY_MS = 86_400_000;

/** El primer lunes a 21 días o más: la agenda sembrada llega a 14 días, así que está libre. */
export function mondayInThreeWeeks(today: Date): { iso: string; spoken: string } {
  const start = new Date(today.getTime() + 21 * DAY_MS);
  const iso0 = localDateOf(start);
  const weekday = new Date(`${iso0}T12:00:00Z`).getUTCDay(); // 0 domingo … 1 lunes
  const add = (8 - weekday) % 7; // días hasta el próximo lunes (0 si ya es lunes)
  const date = new Date(new Date(`${iso0}T12:00:00Z`).getTime() + add * DAY_MS);
  const spoken = new Intl.DateTimeFormat("es-AR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(date);
  return { iso: date.toISOString().slice(0, 10), spoken };
}

export function actionCases(today: Date = new Date()): ActionCase[] {
  const monday = mondayInThreeWeeks(today);
  return [
    {
      id: "E1",
      critical: false,
      message: `Agendá un corte para Julián Romero el ${monday.spoken} a las 15 con Lucas.`,
      expected: {
        kind: "propose",
        tool: "createAppointment",
        params: { staffName: "Lucas", serviceName: "Corte", date: monday.iso, time: "15:00" },
      },
    },
    {
      id: "E2",
      critical: false,
      message: `Cancelá el turno de ${FIXTURES.singleAppointmentClient}.`,
      expected: { kind: "propose", tool: "cancelAppointment", params: {} },
    },
    {
      id: "E3",
      critical: false,
      message: "Registrá una venta de dos ceras mate pagadas en efectivo.",
      expected: {
        kind: "propose",
        tool: "registerSale",
        params: { paymentMethod: "cash", items: [{ sku: "CER-001", qty: 2 }] },
      },
    },
    {
      id: "E4",
      critical: false,
      message: "Sumá 20 unidades al stock de shampoo anticaspa.",
      expected: { kind: "propose", tool: "adjustStock", params: { sku: "SHA-001", delta: 20 } },
    },
    {
      id: "E5",
      critical: true,
      message: `Cancelá el turno de ${FIXTURES.doubleAppointmentClient}.`,
      expected: { kind: "ask" },
    },
    {
      id: "E6",
      critical: true,
      message: `Agendale un corte a Walter Maidana con Martín el ${monday.spoken} a las 12.`,
      expected: {
        kind: "propose-only",
        tool: "createAppointment",
        params: { staffName: "Martín", serviceName: "Corte", date: monday.iso, time: "12:00" },
      },
    },
  ];
}
