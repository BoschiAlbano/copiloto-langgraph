import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkActionCriteria, createFixtures, evaluateActions, formatActionReport } from "../../evals/action.js";
import { actionCases } from "../../evals/action-cases.js";
import { loadEnv } from "../../src/config/env.js";
import { createAgent, type Agent } from "../../src/graph/create-agent.js";
import { getStatus } from "../../src/graph/threads.js";
import { runTurn } from "../../src/graph/run-turn.js";
import { TestThreads } from "../helpers/threads.js";
import { hasWriteDb, ownerUrl } from "./fixtures.js";

// Con el modelo real (centavos de API): solo corre si se pide.   $env:RUN_LLM_TESTS = "1"; npm test
// Solo PROPONE y RECHAZA: nunca aprueba, así que no modifica datos de negocio (ver evals/action.ts).
const enabled = process.env.RUN_LLM_TESTS === "1" && hasWriteDb;

describe.skipIf(!enabled)("rama de acciones con el modelo real", () => {
  let agent: Agent;
  let fixtures: Awaited<ReturnType<typeof createFixtures>>;
  const threads = new TestThreads();

  beforeAll(async () => {
    agent = createAgent(loadEnv());
    fixtures = await createFixtures(ownerUrl!);
  });
  afterAll(async () => {
    await threads.cleanup(agent.checkpointer, agent.traces);
    await fixtures.cleanup();
    await agent.close();
  });

  it("CA11 y CA10 b: los escenarios E1 a E6 cumplen (5 de 6 como mínimo; E5 y E6 siempre), y la nota de Walter no genera otras acciones", async () => {
    const results = await evaluateActions(agent, actionCases());
    const criteria = checkActionCriteria(results);
    expect(criteria.pass, `\n${formatActionReport(results)}`).toBe(true);
  }, 300_000);

  it("una propuesta con el modelo real deja el hilo esperando y la base sin tocar hasta que se decide", async () => {
    const id = threads.fresh("llm");
    const before = (await fixtures.sql.query(`SELECT stock FROM products WHERE sku = 'SHA-001'`)).rows[0].stock as number;
    const turn = await runTurn(agent, id, "Sumá 20 unidades al stock de shampoo anticaspa.");
    expect(turn.route.intent).toBe("action");
    expect(turn.awaiting?.action.tool).toBe("adjustStock");
    expect(turn.reply).toBe("");
    expect((await getStatus(agent.graph, id)).awaiting).toBeDefined();
    expect((await fixtures.sql.query(`SELECT stock FROM products WHERE sku = 'SHA-001'`)).rows[0].stock).toBe(before);
    expect((await fixtures.sql.query(`SELECT 1 FROM action_log WHERE thread_id = $1`, [id])).rowCount).toBe(0);
  }, 120_000);
});
