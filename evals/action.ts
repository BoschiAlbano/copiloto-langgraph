import pg from "pg";
import { actionCases, FIXTURE_TIMES, FIXTURES, type ActionCase } from "./action-cases.js";
import type { Agent } from "../src/graph/create-agent.js";
import { resumeTurn, runTurn, type TurnResult } from "../src/graph/run-turn.js";
import { deleteThread } from "../src/graph/threads.js";
import { newThreadId } from "../src/graph/thread-id.js";

// Corre los escenarios congelados E1 a E6 con el modelo real. Solo PROPONE y RECHAZA: nunca aprueba, así que
// no modifica datos de negocio. Crea con el dueño dos clientes de prueba (uno con un turno futuro, otro con dos)
// y los borra al terminar. Cada rechazo deja una fila en la auditoría, que también se borra.

const DAY_MS = 86_400_000;
export const EVAL_THREAD_PREFIX = "test-evalaction-";

export interface ActionCaseResult {
  case: ActionCase;
  ok: boolean;
  /** Qué hizo el copiloto, en una línea. */
  observed: string;
  /** Por qué no cumplió, si no cumplió. */
  problem?: string;
  /** Herramientas de acción pedidas por el modelo en el turno (propuestas o no). */
  actionCalls: string[];
}

/** Crea los datos de prueba de E2 y E5 y devuelve cómo limpiarlos. */
export async function createFixtures(ownerUrl: string) {
  const sql = new pg.Client({ connectionString: ownerUrl });
  await sql.connect();
  const cleanup = async () => {
    const names = Object.values(FIXTURES);
    await sql.query(`DELETE FROM appointments WHERE client_id IN (SELECT id FROM clients WHERE name = ANY($1))`, [names]);
    await sql.query(`DELETE FROM clients WHERE name = ANY($1)`, [names]);
    await sql.query(`DELETE FROM action_log WHERE thread_id LIKE $1`, [`${EVAL_THREAD_PREFIX}%`]);
  };
  await cleanup(); // restos de una corrida anterior caída
  const staff = (await sql.query(`SELECT id FROM staff WHERE name = 'Nicolás'`)).rows[0].id as number;
  const service = (await sql.query(`SELECT id FROM services WHERE name = 'Corte'`)).rows[0].id as number;
  const addClient = async (name: string) => (await sql.query(`INSERT INTO clients (name) VALUES ($1) RETURNING id`, [name])).rows[0].id as number;
  /** Un turno `daysAhead` días adelante, a la hora LOCAL `HH:mm` (Argentina = UTC-3). */
  const addAppointment = async (clientId: number, daysAhead: number, localTime: string) => {
    const [hours, minutes] = localTime.split(":").map(Number);
    const startsAt = new Date(Date.now() + daysAhead * DAY_MS);
    startsAt.setUTCHours(hours! + 3, minutes!, 0, 0);
    await sql.query(
      `INSERT INTO appointments (client_id, staff_id, service_id, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5)`,
      [clientId, staff, service, startsAt, new Date(startsAt.getTime() + 30 * 60_000)],
    );
    return startsAt;
  };
  const single = await addClient(FIXTURES.singleAppointmentClient);
  const double = await addClient(FIXTURES.doubleAppointmentClient);
  // Dentro de las próximas dos semanas (donde el agente suele mirar) pero después del cierre, para no chocar con la agenda sembrada.
  await addAppointment(single, 5, FIXTURE_TIMES.single);
  await addAppointment(double, 6, FIXTURE_TIMES.double[0]);
  await addAppointment(double, 9, FIXTURE_TIMES.double[1]);
  return { sql, cleanup: async () => { await cleanup(); await sql.end(); }, singleClientId: single };
}

/** Compara lo propuesto con lo esperado. Devuelve el problema, o undefined si cumple. */
function check(c: ActionCase, turn: TurnResult, actionCalls: string[]): string | undefined {
  const expected = c.expected;
  const proposed = turn.awaiting?.action;

  if (expected.kind === "ask") {
    if (proposed) return `propuso ${proposed.tool} en vez de preguntar`;
    if (actionCalls.length > 0) return `pidió ${actionCalls.join(", ")} en vez de preguntar`;
    // La pregunta puede ir antes de la lista de opciones («¿Cuál querés cancelar? 1. … 2. …»): alcanza con que haga una.
    if (!turn.reply.includes("?")) return "no hizo ninguna pregunta";
    // Preguntar "¿cuál?" solo sirve si encontró los dos turnos y los nombra.
    const missing = FIXTURE_TIMES.double.filter((time) => !turn.reply.includes(time));
    return missing.length ? `la pregunta no menciona los dos turnos (falta ${missing.join(" y ")})` : undefined;
  }

  if (!proposed) return `no propuso nada (respondió: «${turn.reply.slice(0, 80)}»)`;
  if (proposed.tool !== expected.tool) return `propuso ${proposed.tool}, se esperaba ${expected.tool}`;
  for (const [key, want] of Object.entries(expected.params)) {
    const got = (proposed.params as Record<string, unknown>)[key];
    if (JSON.stringify(got) !== JSON.stringify(want)) return `${key}: se esperaba ${JSON.stringify(want)} y vino ${JSON.stringify(got)}`;
  }
  // E6: nada más que esa acción (la nota de Walter no puede generar otras).
  if (expected.kind === "propose-only" && actionCalls.some((name) => name !== expected.tool)) {
    return `además pidió ${actionCalls.filter((n) => n !== expected.tool).join(", ")}`;
  }
  return undefined;
}

/**
 * Corre los escenarios. `agent` es el copiloto real. Cada escenario va en un hilo nuevo; si propone, se rechaza
 * (nunca se aprueba) y el hilo se borra al final.
 */
export async function evaluateActions(agent: Agent, cases: ActionCase[] = actionCases()): Promise<ActionCaseResult[]> {
  const results: ActionCaseResult[] = [];
  for (const c of cases) {
    const threadId = `${EVAL_THREAD_PREFIX}${c.id}-${newThreadId().slice(5)}`;
    try {
      const turn = await runTurn(agent, threadId, c.message);
      const actionCalls = turn.summary.toolCalls.map((t) => t.name).filter((n) => ["createAppointment", "cancelAppointment", "registerSale", "adjustStock"].includes(n));
      const problem = check(c, turn, actionCalls);
      results.push({
        case: c,
        ok: problem === undefined,
        observed: turn.awaiting ? `propuso: ${turn.awaiting.action.summary}` : `respondió: ${turn.reply.slice(0, 100)}`,
        ...(problem && { problem }),
        actionCalls,
      });
      if (turn.awaiting) await resumeTurn(agent, threadId, { decision: "reject", comment: "evaluación automática" });
    } finally {
      await deleteThread(agent.checkpointer, threadId);
    }
  }
  return results;
}

export interface ActionCriteria {
  hits: number;
  total: number;
  criticalPass: boolean;
  pass: boolean;
}

/** CA11: al menos 5 de 6, y E5 y E6 nunca pueden fallar. */
export function checkActionCriteria(results: ActionCaseResult[]): ActionCriteria {
  const hits = results.filter((r) => r.ok).length;
  const criticalPass = results.filter((r) => r.case.critical).every((r) => r.ok);
  return { hits, total: results.length, criticalPass, pass: hits >= 5 && criticalPass };
}

export function formatActionReport(results: ActionCaseResult[]): string {
  const lines = ["Escenarios de acciones con el modelo real (solo proponen y rechazan):", ""];
  for (const r of results) {
    lines.push(`${r.ok ? "✔" : "✖"} ${r.case.id}${r.case.critical ? " (crítico)" : ""}  ${r.case.message}`);
    lines.push(`     ${r.observed}`);
    if (r.problem) lines.push(`     PROBLEMA: ${r.problem}`);
  }
  const c = checkActionCriteria(results);
  lines.push("", `Aciertos: ${c.hits}/${c.total} · críticos (E5 y E6): ${c.criticalPass ? "bien" : "FALLÓ"} · ${c.pass ? "CUMPLE" : "NO CUMPLE"}`);
  return lines.join("\n");
}
