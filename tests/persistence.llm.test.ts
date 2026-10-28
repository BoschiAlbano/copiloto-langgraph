import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, type Env } from "../src/config/env.js";
import { createAgent } from "../src/graph/create-agent.js";
import { runTurn } from "../src/graph/run-turn.js";
import { getStatus } from "../src/graph/threads.js";
import { TestThreads } from "./helpers/threads.js";

// Con el modelo real (centavos de API): solo corre si se pide.
//   $env:RUN_LLM_TESTS = "1"; npm test
const enabled = process.env.RUN_LLM_TESTS === "1";
const AR = `'America/Argentina/Buenos_Aires'`;
const digits = (text: string) => text.replace(/(?<=\d)[.\s](?=\d{3}\b)/g, "");

describe.skipIf(!enabled)("CA1 con el modelo real: retomar tras reiniciar", () => {
  let env: Env;
  let sql: pg.Client;
  const threads = new TestThreads();

  beforeAll(async () => {
    env = loadEnv();
    sql = new pg.Client({ connectionString: process.env.DATABASE_URL_WRITE });
    await sql.connect();
  });
  afterAll(async () => {
    const agent = createAgent(env);
    await threads.cleanup(agent.checkpointer);
    await agent.close();
    await sql.end();
  });

  it("'¿Y pasado mañana?' después de reiniciar se entiende por el historial guardado", async () => {
    const { rows } = await sql.query(
      `SELECT COUNT(*)::int AS n FROM appointments
        WHERE (starts_at AT TIME ZONE ${AR})::date = (now() AT TIME ZONE ${AR})::date + 2
          AND status <> 'cancelled'`,
    );
    const expected = rows[0].n as number;
    expect(expected).toBeGreaterThan(0);

    const id = threads.fresh("llm");

    // Primer "programa".
    const first = createAgent(env);
    const t1 = await runTurn(first, id, "¿Cuántos turnos hay mañana?");
    expect(t1.route.intent).toBe("query");
    await first.close();

    // Segundo "programa": todo nuevo, solo comparte la base.
    const second = createAgent(env);
    try {
      const t2 = await runTurn(second, id, "¿Y pasado mañana?");
      expect(t2.route.intent).toBe("query");
      expect(t2.summary.toolCalls.map((c) => c.name)).toContain("listAppointments");
      expect(digits(t2.reply)).toMatch(new RegExp(`\\b${expected}\\b`));
      expect((await getStatus(second.graph, id)).messages.filter((m) => m.type === "human")).toHaveLength(2);
    } finally {
      await second.close();
    }
  }, 120_000);
});
