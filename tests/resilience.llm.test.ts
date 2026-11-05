import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FAILURE_CASES, type FailureCase } from "../evals/resilience-cases.js";
import { loadEnv } from "../src/config/env.js";
import { createAgent } from "../src/graph/create-agent.js";
import { streamRunTurn } from "../src/graph/run-turn.js";
import { getStatus } from "../src/graph/threads.js";
import type { UiEvent } from "../src/web/events.js";
import { failing } from "./helpers/failing.js";
import { TestThreads } from "./helpers/threads.js";

// Fase 10 (T8, CA1 con el modelo real): los escenarios F1 a F3 de evals/resilience-cases.ts. La base no se apaga: la
// herramienta real se envuelve con una que falla a propósito (tests/helpers/failing.ts). Cuestan unos centavos:
//   $env:RUN_LLM_TESTS = "1"; npx vitest run tests/resilience.llm.test.ts
const enabled = process.env.RUN_LLM_TESTS === "1";
const AR = `'America/Argentina/Buenos_Aires'`;

/** Quita separadores de miles: "1.569" → "1569". */
const digits = (text: string) => text.replace(/(?<=\d)[.\s](?=\d{3}\b)/g, "");
/** La respuesta reconoce que no pudo consultar (R3): no hace falta una frase exacta. */
const ADMITS = /\bno (pude|pudimos|se pudo|logré|puedo|fue posible|está disponible|responde)|problema|fall[aó]|caíd|error/i;

const CASES = Object.fromEntries(FAILURE_CASES.map((c) => [c.id, c])) as Record<FailureCase["id"], FailureCase>;

describe.skipIf(!enabled)("fallas de la base con el modelo real (F1 a F3)", () => {
  let sql: pg.Client;
  const threads = new TestThreads();

  beforeAll(async () => {
    loadEnv(); // carga el .env
    sql = new pg.Client({ connectionString: process.env.DATABASE_URL_WRITE });
    await sql.connect();
    // Los avisos de reintento y de error van a la consola de quien opera: acá serían ruido.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(async () => {
    await sql.end();
    vi.restoreAllMocks();
  });

  /** Corre el pedido del escenario con su falla simulada, con los eventos en vivo (como la web). */
  async function runCase(c: FailureCase) {
    let wrapped: ReturnType<typeof failing> | undefined;
    const agent = createAgent(loadEnv(), {
      wrapReadTools: (tools) => tools.map((t) => (t.name === c.failure.tool ? (wrapped = failing(t, c.failure.times)) : t)),
    });
    try {
      const id = threads.fresh("resilience");
      const events: UiEvent[] = [];
      for await (const event of streamRunTurn(agent, id, c.message)) events.push(event);
      const done = events.at(-1);
      if (done?.type !== "done") throw new Error(`el turno no terminó: ${JSON.stringify(done)}`);
      const retries = events.filter((e) => e.type === "retry" && e.target === c.failure.tool);
      const status = await getStatus(agent.graph, id);
      await threads.cleanup(agent.checkpointer, agent.traces);
      return { result: done.result, retries, pending: status.pending, attempts: wrapped!.attempts() };
    } finally {
      await agent.close();
    }
  }

  it("F1: dos fallas y anda: la misma cantidad que da SQL, con 2 reintentos a la vista", async () => {
    const f1 = CASES.F1;
    const { rows } = await sql.query(
      `SELECT COUNT(*)::int AS n FROM appointments
       WHERE (starts_at AT TIME ZONE ${AR})::date = (now() AT TIME ZONE ${AR})::date + 1 AND status <> 'cancelled'`,
    );
    const expected = rows[0].n as number;
    const { result, retries, pending, attempts } = await runCase(f1);
    expect(retries.map((e) => e.type === "retry" && e.attempt)).toEqual([2, 3]);
    expect(retries).toHaveLength(f1.expected.retries);
    expect(attempts).toBe(3);
    expect(result.summary.failedTools).toEqual([]);
    expect(digits(result.reply)).toMatch(new RegExp(`\\b${expected}\\b`));
    expect(pending).toBe(false);
  }, 90_000);

  for (const id of ["F2", "F3"] as const) {
    it(`${id}: falla siempre: lo dice, no inventa la cifra y el hilo queda listo`, async () => {
      const c = CASES[id];
      const { result, retries, pending } = await runCase(c);
      // Cada llamada del agente a la herramienta reintenta 2 veces; puede llamarla más de una vez.
      expect(retries.length).toBeGreaterThanOrEqual(c.expected.retries);
      expect(result.summary.failedTools).toContain(c.failure.tool);
      expect(result.reply, "reconoce que no pudo consultar").toMatch(ADMITS);
      expect(result.reply, "no inventa la cifra").not.toMatch(c.expected.forbidden!);
      expect(pending).toBe(false);
    }, 90_000);
  }
});
