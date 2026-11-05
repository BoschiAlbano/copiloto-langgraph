import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkMemoryCriteria, evalNamespace, evaluateApplyCases, evaluateMemoryCases, formatMemoryReport } from "../evals/memory.js";
import { loadEnv } from "../src/config/env.js";
import { createAgent, type Agent } from "../src/graph/create-agent.js";
import { runTurn } from "../src/graph/run-turn.js";
import { clearMemories } from "../src/memory/store.js";
import { TestThreads } from "./helpers/threads.js";
import { hasDb } from "./tools/helpers.js";

// Con el modelo real (centavos de API) y la base: solo corre si se pide.   $env:RUN_LLM_TESTS = "1"; npm test
// Usa un namespace de memoria propio (no toca las memorias del negocio), solo propone acciones y borra sus hilos.
const enabled = process.env.RUN_LLM_TESTS === "1" && hasDb;

describe.skipIf(!enabled)("memoria de largo plazo con el modelo real (fase 8)", () => {
  let agent: Agent;
  beforeAll(() => {
    agent = createAgent(loadEnv(), { memoryNamespace: evalNamespace() });
  });
  afterAll(async () => {
    await agent.close();
  });

  it("CA1, CA3, CA4 y CA5: G1 a G8 (7 de 8 como mínimo; G1, G5 y G7 siempre) y A1 a A4, en tres corridas seguidas", async () => {
    for (let run = 1; run <= 3; run++) {
      const memory = await evaluateMemoryCases(agent);
      const apply = await evaluateApplyCases(agent);
      expect(checkMemoryCriteria(memory, apply).pass, `corrida ${run}\n${formatMemoryReport(memory, apply)}`).toBe(true);
    }
  }, 900_000);
});

describe.skipIf(!enabled)("regresión: una preferencia de formato con un ejemplo (corrección después del cierre)", () => {
  let agent: Agent;
  beforeAll(() => {
    agent = createAgent(loadEnv(), { memoryNamespace: evalNamespace() });
  });
  afterAll(async () => {
    await clearMemories(agent.memory);
    await agent.close();
  });

  it("se anota (el número del ejemplo no es una cifra del negocio) y se aplica en un hilo nuevo", async () => {
    const threads = new TestThreads();
    try {
      const saved = await runTurn(agent, threads.fresh("test"), "quiero una nueva preferencia, cada vez que me traigas el stock de un prodcutos debe ser de la siguiente forma: ejemplo ceramate 30 U/S");
      expect(saved.reply, saved.reply).toMatch(/^Anoté esta preferencia/);
      const asked = await runTurn(agent, threads.fresh("test"), "¿Cuánto stock hay de cera mate?");
      expect(asked.reply, asked.reply).toMatch(/\d+ U\/S/);
    } finally {
      await threads.cleanup(agent.checkpointer, agent.traces);
    }
  }, 180_000);
});
