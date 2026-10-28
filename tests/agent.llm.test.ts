import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { createAgent, type Agent } from "../src/graph/create-agent.js";
import { runTurn } from "../src/graph/run-turn.js";
import { TestThreads } from "./helpers/threads.js";

// Pruebas con el modelo real: cuestan unos centavos de API, así que solo corren si se pide.
//   $env:RUN_LLM_TESTS = "1"; npm test
const enabled = process.env.RUN_LLM_TESTS === "1";
const AR = `'America/Argentina/Buenos_Aires'`;

/** Quita separadores de miles y símbolos: "$ 1.569.100" → "1569100". */
const digits = (text: string) => text.replace(/(?<=\d)[.\s](?=\d{3}\b)/g, "");

describe.skipIf(!enabled)("agente con el modelo real", () => {
  let agent: Agent;
  let sql: pg.Client;
  const threads = new TestThreads();

  beforeAll(async () => {
    agent = createAgent(loadEnv()); // carga el .env
    sql = new pg.Client({ connectionString: process.env.DATABASE_URL_WRITE });
    await sql.connect();
  });
  afterAll(async () => {
    await threads.cleanup(agent.checkpointer);
    await agent.close();
    await sql.end();
  });

  it("CA1: '¿cuántos turnos hay mañana?' responde el número que da SQL (sin cancelados)", async () => {
    const { rows } = await sql.query(
      `SELECT COUNT(*)::int AS n FROM appointments
       WHERE (starts_at AT TIME ZONE ${AR})::date = (now() AT TIME ZONE ${AR})::date + 1
         AND status <> 'cancelled'`,
    );
    const expected = rows[0].n as number;
    expect(expected).toBeGreaterThan(0);

    const turn = await runTurn(agent, threads.fresh(), "¿Cuántos turnos hay mañana?");

    expect(turn.summary.toolCalls.map((c) => c.name)).toContain("listAppointments");
    expect(digits(turn.reply)).toMatch(new RegExp(`\\b${expected}\\b`));
  }, 60_000);

  it("informa el stock bajo sin inventar productos", async () => {
    const { rows } = await sql.query(`SELECT name FROM products WHERE stock < min_stock ORDER BY name`);
    const turn = await runTurn(agent, threads.fresh(), "¿Qué productos tienen el stock bajo?");

    expect(turn.summary.toolCalls.map((c) => c.name)).toContain("getStockLevels");
    for (const { name } of rows) expect(turn.reply.toLowerCase()).toContain(name.toLowerCase());
  }, 60_000);

  it("resuelve un pedido que necesita dos herramientas encadenadas", async () => {
    const turn = await runTurn(agent, threads.fresh(), "¿Cuántos turnos tiene agendados Santiago Pereyra de hoy en adelante, hasta fin de mes?");
    const names = turn.summary.toolCalls.map((c) => c.name);
    expect(names).toContain("findClient");
    expect(names).toContain("listAppointments");
  }, 90_000);
});
