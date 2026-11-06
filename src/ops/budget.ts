import type { TraceStore } from "../observability/store.js";

// El tope de gasto diario (fase 12, R5). Lo que se gastó hoy sale de las trazas (fase 11): cada turno guarda su costo.
// Las corridas de evaluación no cuentan (tienen su propio informe de costo).

/** La medianoche de hoy en Argentina (UTC−3, sin horario de verano), como instante. */
export function startOfTodayAR(now: Date = new Date()): Date {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(now);
  return new Date(`${day}T00:00:00-03:00`);
}

const usd = (n: number) => `US$ ${n.toFixed(2).replace(".", ",")}`;

/** Se alcanzó el tope de gasto del día: el turno no llama al modelo. */
export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(
      `Se alcanzó el tope de gasto de hoy (${usd(spentUsd)} de ${usd(budgetUsd)}). No se llamó al modelo: el hilo quedó como estaba. ` +
        "El tope se reinicia a la medianoche; para cambiarlo, DAILY_BUDGET_USD en .env.",
    );
    this.name = "BudgetExceededError";
  }
}

/** Lo que se gastó hoy en turnos (sin las evaluaciones), según las trazas. */
export const spentToday = (traces: Pick<TraceStore, "costSince">, now: Date = new Date()) => traces.costSince(startOfTodayAR(now));

/** Lanza `BudgetExceededError` si ya se gastó el tope. Un tope de 0 (o sin tope) no limita. */
export async function checkBudget(budgetUsd: number | undefined, spent: (() => Promise<number>) | undefined): Promise<void> {
  if (!budgetUsd || !spent) return;
  const value = await spent();
  if (value >= budgetUsd) throw new BudgetExceededError(value, budgetUsd);
}
