import { checkPlanCriteria, evaluatePlanner, formatPlanReport, type PlanCaseResult } from "../../evals/report.js";
import { loadEnv } from "../config/env.js";
import { makeReportPlanModel } from "../graph/models.js";

// Evalúa al planificador de reportes con el modelo real contra los escenarios congelados P1 a P8 (evals/report-cases.ts).
// No toca la base. Gasta API (centavos con Haiku).
// Uso: npm run eval:report            (una corrida)
//      npm run eval:report -- --runs 3
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

const model = makeReportPlanModel(env);
const all: PlanCaseResult[][] = [];
for (let run = 1; run <= runs; run++) {
  if (runs > 1) console.log(`\n=== Corrida ${run} de ${runs} ===`);
  const results = await evaluatePlanner(model);
  all.push(results);
  console.log(formatPlanReport(results));
}
if (runs > 1) console.log(`\nCorridas que cumplen: ${all.filter((r) => checkPlanCriteria(r).pass).length}/${runs}`);
process.exit(all.every((r) => checkPlanCriteria(r).pass) ? 0 : 1);
