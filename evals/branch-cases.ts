// Escenarios congelados de las ramas del hilo (ver specs/ramas-del-hilo.md). Se escribieron ANTES de hacer el panel.
// Se corren en el navegador (web/e2e/branches.spec.ts), con el modelo real y la base real.
import { tuesdayInThreeWeeks } from "./web-cases.js";

/** Un paso en la página. */
export type BranchStep =
  | { kind: "ask"; text: string }
  | { kind: "edit"; original: string; text: string }
  | { kind: "retry" }
  | { kind: "approve" }
  | { kind: "reject" }
  /** Abrir en el panel esta versión (1 = la original). */
  | { kind: "open-branch"; version: number }
  | { kind: "reload" };

export interface BranchCase {
  id: "B1" | "B2" | "B3" | "B4";
  /** Los pasos, en orden. B2 y B3 siguen desde el final del anterior. */
  steps: BranchStep[];
  /** Sigue en el mismo hilo que este escenario. */
  continues?: "B1" | "B2";
  expected: {
    /** Cuántas versiones muestra el panel al final. */
    branches: number;
    /** La versión actual y su mensaje de separación. */
    current: { version: number; label: string };
    /** Los mensajes de la persona que se ven, en orden. */
    humanMessages?: string[];
    /** La última respuesta tiene que traer esto, y no lo otro (B3: el modelo ve la rama elegida). */
    reply?: { includes: RegExp; excludes: RegExp };
    /** El registro de acciones del hilo, en orden: abrir una rama no lo cambia. */
    loggedDecisions?: string[];
    /** La acción ejecutada, una sola vez, a esta fecha y hora. */
    executedOnceAt?: string;
    /** La versión que ejecutó una acción, marcada en el panel. */
    markedExecuted?: number;
  };
}

export function branchCases(today: Date = new Date()): BranchCase[] {
  const tuesday = tuesdayInThreeWeeks(today);
  const book = `Agendá un corte para Julián Romero el ${tuesday.spoken} a las 15 con Lucas.`;
  return [
    {
      id: "B1",
      steps: [
        { kind: "ask", text: "¿Cuántos turnos hay mañana?" },
        { kind: "edit", original: "¿Cuántos turnos hay mañana?", text: "¿Cuántos turnos hay pasado mañana?" },
      ],
      expected: { branches: 2, current: { version: 2, label: "¿Cuántos turnos hay pasado mañana?" }, humanMessages: ["¿Cuántos turnos hay pasado mañana?"] },
    },
    {
      id: "B2",
      continues: "B1",
      steps: [{ kind: "open-branch", version: 1 }, { kind: "reload" }],
      expected: { branches: 2, current: { version: 1, label: "¿Cuántos turnos hay mañana?" }, humanMessages: ["¿Cuántos turnos hay mañana?"] },
    },
    {
      id: "B3",
      continues: "B2",
      steps: [{ kind: "ask", text: "¿Qué te pregunté recién? Repetímelo textual." }],
      expected: {
        branches: 2,
        current: { version: 1, label: "¿Cuántos turnos hay mañana?" },
        humanMessages: ["¿Cuántos turnos hay mañana?", "¿Qué te pregunté recién? Repetímelo textual."],
        reply: { includes: /mañana/i, excludes: /pasado mañana/i },
      },
    },
    {
      id: "B4",
      // Al reintentar no hay tarjeta: el turno ya existe (lo creó la versión 1; la base no cambia de rama).
      steps: [{ kind: "ask", text: book }, { kind: "approve" }, { kind: "retry" }, { kind: "open-branch", version: 1 }],
      expected: {
        branches: 2,
        current: { version: 1, label: book },
        loggedDecisions: ["approved"],
        executedOnceAt: `${tuesday.iso}T15:00`,
        markedExecuted: 1,
      },
    },
  ];
}
