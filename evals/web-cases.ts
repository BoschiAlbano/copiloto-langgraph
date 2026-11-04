// Escenarios congelados de la fase 9 (ver specs/fase-09-streaming-web.md). Se escribieron ANTES de la interfaz web.
// Se corren en el navegador con Playwright (web/e2e), cada uno en un hilo nuevo que se borra al terminar.
import { mondayInThreeWeeks } from "./action-cases.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** El martes que sigue al lunes a tres semanas: fuera de la agenda del seed y no es lunes (la regla de la fase 8). */
export function tuesdayInThreeWeeks(today: Date): { iso: string; spoken: string } {
  const monday = mondayInThreeWeeks(today);
  const date = new Date(new Date(`${monday.iso}T12:00:00Z`).getTime() + DAY_MS);
  const spoken = new Intl.DateTimeFormat("es-AR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(date);
  return { iso: date.toISOString().slice(0, 10), spoken };
}

/** Lo que se hace en la página después de mandar el pedido. */
export type WebStep =
  | { kind: "none" }
  | { kind: "reject"; comment: string }
  | { kind: "edit-then-approve"; params: Record<string, unknown> }
  | { kind: "reload-then-approve" };

export interface WebCase {
  id: "W1" | "W2" | "W3" | "W4" | "W5";
  message: string;
  step: WebStep;
  /** Si aprueba una acción: escribe en la base (va con las pruebas de escritura y después `db:reset`). */
  writes: boolean;
  expected: {
    /** Intenciones de la ruta, en orden. */
    route: ("query" | "action" | "report")[];
    /** Herramienta que tiene que verse ANTES que el texto de la respuesta. */
    toolBeforeReply?: string;
    /** Cuántas veces, como mínimo, se tiene que ver crecer el texto de la respuesta antes de terminar. */
    progressiveSteps?: number;
    /** Aparece la tarjeta de aprobación. */
    card?: boolean;
    /** Lo que tiene que decir la tarjeta (después de editar, si se editó). */
    cardParams?: Record<string, unknown>;
    /** El turno queda creado en la base, a esa hora, una sola vez. */
    createdAt?: string;
    /** Nada se escribe en la base. */
    noWrites?: boolean;
    /** Secciones del reporte que se ven terminadas antes que el reporte. */
    reportSections?: ("sales" | "appointments" | "stock")[];
  };
}

export function webCases(today: Date = new Date()): WebCase[] {
  const tuesday = tuesdayInThreeWeeks(today);
  const book = `Agendá un corte para Julián Romero el ${tuesday.spoken} a las 15 con Lucas.`;
  const proposal = { staffName: "Lucas", serviceName: "Corte", date: tuesday.iso };
  return [
    {
      id: "W1",
      message: "¿Cuántos turnos hay mañana?",
      step: { kind: "none" },
      writes: false,
      expected: { route: ["query"], toolBeforeReply: "listAppointments", progressiveSteps: 3 },
    },
    {
      id: "W2",
      message: book,
      step: { kind: "reject", comment: "mejor otro día" },
      writes: false,
      expected: { route: ["action"], card: true, cardParams: { ...proposal, time: "15:00" }, noWrites: true },
    },
    {
      id: "W3",
      message: book,
      step: { kind: "edit-then-approve", params: { time: "16:00" } },
      writes: true,
      expected: { route: ["action"], card: true, cardParams: { ...proposal, time: "16:00" }, createdAt: "16:00" },
    },
    {
      id: "W4",
      message: book,
      step: { kind: "reload-then-approve" },
      writes: true,
      expected: { route: ["action"], card: true, cardParams: { ...proposal, time: "15:00" }, createdAt: "15:00" },
    },
    {
      id: "W5",
      message: "Armame el resumen de la semana.",
      step: { kind: "none" },
      writes: false,
      expected: { route: ["report"], reportSections: ["sales", "appointments", "stock"] },
    },
  ];
}
