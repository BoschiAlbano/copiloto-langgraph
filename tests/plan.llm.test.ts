import { describe, expect, it } from "vitest";
import { checkPlanCriteria, evaluatePlans, formatPlanReport } from "../evals/plan.js";
import { loadEnv } from "../src/config/env.js";
import { makeRouterModel } from "../src/graph/models.js";

// Con el modelo real (centavos de API): solo corre si se pide.   $env:RUN_LLM_TESTS = "1"; npm test
const enabled = process.env.RUN_LLM_TESTS === "1";

describe.skipIf(!enabled)("plan del router con el modelo real (fase 7)", () => {
  it("CA6: M1 a M8 cumplen (7 de 8 como mínimo, y M1, M7 y M8 siempre) en tres corridas seguidas", async () => {
    const model = makeRouterModel(loadEnv());
    for (let run = 1; run <= 3; run++) {
      const results = await evaluatePlans(model);
      expect(checkPlanCriteria(results).pass, `corrida ${run}\n${formatPlanReport(results)}`).toBe(true);
    }
  }, 240_000);
});
