// Escenarios congelados de la fase 10 (ver specs/fase-10-errores-reintentos.md). Se escribieron ANTES de tocar los
// prompts. F1 a F3 simulan fallas de la base envolviendo las herramientas reales; F4 a F6 se corren en el navegador.
import { tuesdayInThreeWeeks } from "./web-cases.js";

/** Cómo falla una herramienta en un escenario: las primeras `times` llamadas (o todas) con un error transitorio. */
export interface SimulatedFailure {
  tool: "listAppointments" | "getStockLevels";
  times: number | "always";
}

export interface FailureCase {
  id: "F1" | "F2" | "F3";
  message: string;
  failure: SimulatedFailure;
  expected: {
    /** Cuántos reintentos tienen que verse (eventos `retry`). */
    retries: number;
    /** La respuesta tiene la misma cantidad que sin fallas (se compara con un turno sin fallas). */
    sameAnswerAsHealthy?: boolean;
    /** La respuesta dice que no pudo consultar, y no trae cifras inventadas. */
    admitsFailure?: boolean;
    /** Expresión que NO puede aparecer en la respuesta (una cifra inventada). */
    forbidden?: RegExp;
  };
}

export const FAILURE_CASES: FailureCase[] = [
  {
    id: "F1",
    message: "¿Cuántos turnos hay mañana?",
    failure: { tool: "listAppointments", times: 2 },
    expected: { retries: 2, sameAnswerAsHealthy: true },
  },
  {
    id: "F2",
    message: "¿Cuántos turnos hay mañana?",
    failure: { tool: "listAppointments", times: "always" },
    // Cada llamada del agente a la herramienta reintenta 2 veces; el agente puede llamarla más de una vez.
    expected: { retries: 2, admitsFailure: true, forbidden: /\b\d+\s+turnos?\b/i },
  },
  {
    id: "F3",
    message: "¿Cuánto stock queda de cera mate?",
    failure: { tool: "getStockLevels", times: "always" },
    expected: { retries: 2, admitsFailure: true, forbidden: /\b\d+\s*(unidades|u\/s|u\b)/i },
  },
];

/** Escenarios de viaje en el tiempo en la web (F4 a F6). */
export interface TimeTravelCase {
  id: "F4" | "F5" | "F6";
  /** El primer mensaje del turno. */
  message: string;
  /** Qué se hace después: editar el mensaje (con el texto nuevo) o reintentar. */
  step: { kind: "approve-then-edit"; text: string } | { kind: "edit"; text: string } | { kind: "retry" };
  expected: {
    /** La nueva respuesta coincide con la de un hilo aparte con este mensaje. */
    sameAsFreshThread?: string;
    /** La rama nueva propone esta hora (y no ejecuta nada hasta aprobar). */
    proposesTime?: string;
    /** La acción original quedó ejecutada una sola vez a esta hora. */
    executedOnceAt?: string;
  };
}

export function timeTravelCases(today: Date = new Date()): TimeTravelCase[] {
  const tuesday = tuesdayInThreeWeeks(today);
  return [
    {
      id: "F4",
      message: "¿Cuántos turnos hay mañana?",
      step: { kind: "edit", text: "¿Cuántos turnos hay pasado mañana?" },
      expected: { sameAsFreshThread: "¿Cuántos turnos hay pasado mañana?" },
    },
    {
      id: "F5",
      message: `Agendá un corte para Julián Romero el ${tuesday.spoken} a las 15 con Lucas.`,
      step: { kind: "approve-then-edit", text: `Agendá un corte para Julián Romero el ${tuesday.spoken} a las 16 con Lucas.` },
      expected: { proposesTime: "16:00", executedOnceAt: `${tuesday.iso}T15:00` },
    },
    {
      id: "F6",
      message: "¿Cuánto stock queda de cera mate?",
      step: { kind: "retry" },
      expected: {},
    },
  ];
}
