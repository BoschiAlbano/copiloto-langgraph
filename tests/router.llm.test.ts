import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCriteria, evaluateClarifications, evaluateRouter, formatReport } from "../evals/router.js";
import { ROUTER_CASES } from "../evals/router-cases.js";
import { loadEnv, type Env } from "../src/config/env.js";
import { createAgent, type Agent } from "../src/graph/create-agent.js";
import { makeClarifyModel, makeRouterModel } from "../src/graph/models.js";
import { runTurn } from "../src/graph/run-turn.js";
import { TestThreads } from "./helpers/threads.js";

// Pruebas con el modelo real: cuestan centavos de API (Haiku), así que solo corren si se pide.
//   $env:RUN_LLM_TESTS = "1"; npm test
const enabled = process.env.RUN_LLM_TESTS === "1";

describe.skipIf(!enabled)("router con el modelo real", () => {
  let env: Env;
  beforeAll(() => {
    env = loadEnv();
  });

  it("CA1, CA2 y CA3: cumple los tres conjuntos de evaluación", async () => {
    const results = await evaluateRouter(makeRouterModel(env));
    const clarifications = await evaluateClarifications(makeClarifyModel(env));
    const criteria = checkCriteria(results, clarifications);
    // El informe viaja en el mensaje de error si algo falla.
    expect(criteria.pass, `\n${formatReport(results, clarifications)}`).toBe(true);
  }, 180_000);

  describe("camino completo con el copiloto real", () => {
    let agent: Agent;
    const threads = new TestThreads();
    beforeAll(() => {
      agent = createAgent(env);
    });
    afterAll(async () => {
      await threads.cleanup(agent.checkpointer, agent.traces);
      await agent.close();
    });

    it("CA4: las 5 frases de charla terminan sin llamar a ninguna herramienta", async () => {
      for (const c of ROUTER_CASES.filter((x) => x.expected === "chat" && x.set === "A")) {
        const turn = await runTurn(agent, threads.fresh(), c.message);
        expect(turn.route.intent, c.message).toBe("chat");
        expect(turn.summary.toolCalls, c.message).toEqual([]);
      }
    }, 120_000);

    it("CA9: el uso incluye al router además del agente", async () => {
      const turn = await runTurn(agent, threads.fresh(), "¿Cuántos turnos hay mañana?");
      expect(turn.route.intent).toBe("query");
      // router + agente (pide la herramienta) + agente (responde) = al menos 3 llamadas
      expect(turn.summary.modelCalls).toBeGreaterThanOrEqual(3);
      expect(turn.summary.inputTokens).toBeGreaterThan(0);
    }, 60_000);
  });
});
