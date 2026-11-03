// Escenarios congelados de la fase 7 (ver specs/fase-07-subgrafos-supervisor.md). Se escribieron ANTES de cambiar
// el prompt del router, y ninguna de estas frases puede aparecer en él (lo verifica un test). Se evalúa el plan YA
// normalizado por el código (R5): las intenciones de sus tareas, en orden. Los nombres existen en el seed.
import type { Intent } from "../src/graph/intents.js";

export interface PlanCase {
  id: "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8";
  /** Si el escenario nunca puede fallar (CA6). */
  critical: boolean;
  message: string;
  /** Intenciones de las tareas del plan normalizado, en el orden en que se hacen. */
  expected: Intent[];
}

export const PLAN_CASES: PlanCase[] = [
  {
    id: "M1",
    critical: true,
    message: "Registrá la venta de un gel fijación fuerte en efectivo y decime cuánto stock queda.",
    expected: ["action", "query"],
  },
  {
    id: "M2",
    critical: false,
    message: "Cancelá el próximo turno de Bruno Castro y armame el resumen de la semana.",
    expected: ["action", "report"],
  },
  {
    id: "M3",
    critical: false,
    message: "Decime cuánto stock queda de gel fijación fuerte y armame el resumen del mes.",
    expected: ["query", "report"],
  },
  {
    id: "M4",
    critical: false,
    message: "¿Cuántos turnos hay mañana y cuánto vendimos hoy?",
    // Dos consultas se unen en una sola tarea: un mismo agente contesta las dos preguntas.
    expected: ["query"],
  },
  {
    id: "M5",
    critical: false,
    message: "¿Cuánto stock hay de gel fijación fuerte? Y registrá la venta de uno en efectivo.",
    // La acción va primero aunque se pida después: la consulta tiene que reflejar el cambio.
    expected: ["action", "query"],
  },
  {
    id: "M6",
    critical: false,
    message: "¡Gracias! ¿Y cuánto vendimos ayer?",
    // La charla combinada con otra tarea se descarta.
    expected: ["query"],
  },
  {
    id: "M7",
    critical: true,
    message: "Armame el resumen de la semana.",
    // Un pedido simple no se parte.
    expected: ["report"],
  },
  {
    id: "M8",
    critical: true,
    message: "Descontá tres peines del stock.",
    // Una acción sola no se acompaña de una consulta.
    expected: ["action"],
  },
];
