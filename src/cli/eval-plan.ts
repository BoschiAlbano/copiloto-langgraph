import { checkPlanCriteria, evaluatePlans, formatPlanReport, type PlanCaseResult } from "../../evals/plan.js";
import { loadEnv } from "../config/env.js";
import { makeRouterModel } from "../graph/models.js";

// Evalúa al router como planificador con el modelo real contra los escenarios congelados M1 a M8
// (evals/plan-cases.ts). No toca la base. Gasta API (centavos con Haiku).
// Uso: npm run eval:plan            (una corrida)
//      npm run eval:plan -- --runs 3
const env = (() => {
  try {
    return loadEnv();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
})();

const runsFlag = process.argv.indexOf("--runs");
const runs = runsFlag === -1 ? 1 : Math.max(1, Number(process.argv[runsFlag + 1]) || 1);

const model = makeRouterModel(env);
const all: PlanCaseResult[][] = [];
for (let run = 1; run <= runs; run++) {
  if (runs > 1) console.log(`\n=== Corrida ${run} de ${runs} ===`);
  const results = await evaluatePlans(model);
  all.push(results);
  console.log(formatPlanReport(results));
}
if (runs > 1) console.log(`\nCorridas que cumplen: ${all.filter((r) => checkPlanCriteria(r).pass).length}/${runs}`);
process.exit(all.every((r) => checkPlanCriteria(r).pass) ? 0 : 1);
