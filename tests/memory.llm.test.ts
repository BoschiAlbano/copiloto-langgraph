import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkMemoryCriteria, evalNamespace, evaluateApplyCases, evaluateMemoryCases, formatMemoryReport } from "../evals/memory.js";
import { loadEnv } from "../src/config/env.js";
import { createAgent, type Agent } from "../src/graph/create-agent.js";
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
