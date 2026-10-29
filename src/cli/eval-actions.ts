import { checkActionCriteria, createFixtures, evaluateActions, formatActionReport, type ActionCaseResult } from "../../evals/action.js";
import { loadEnv } from "../config/env.js";
import { createAgent } from "../graph/create-agent.js";

// Evalúa la rama de acciones con el modelo real contra los escenarios congelados E1 a E6 (evals/action-cases.ts).
// Solo propone y rechaza: no modifica datos de negocio. Gasta API (centavos con Haiku).
// Uso: npm run eval:actions            (una corrida)
//      npm run eval:actions -- --runs 3
const env = (() => {
  try {
    return loadEnv();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
})();

const ownerUrl = process.env.DATABASE_URL_WRITE;
if (!ownerUrl) {
  console.error("Falta DATABASE_URL_WRITE (se usa para crear y borrar los datos de prueba). Revisá tu archivo .env.");
  process.exit(1);
}

const runsFlag = process.argv.indexOf("--runs");
const runs = runsFlag === -1 ? 1 : Math.max(1, Number(process.argv[runsFlag + 1]) || 1);

const fixtures = await createFixtures(ownerUrl);
const agent = createAgent(env);
let exitCode = 0;
try {
  const all: ActionCaseResult[][] = [];
  for (let run = 1; run <= runs; run++) {
    if (runs > 1) console.log(`\n=== Corrida ${run} de ${runs} ===`);
    const results = await evaluateActions(agent);
    all.push(results);
    console.log(formatActionReport(results));
  }
  if (runs > 1) {
    const passes = all.map((r) => checkActionCriteria(r).pass).filter(Boolean).length;
    console.log(`\nCorridas que cumplen: ${passes}/${runs}`);
  }
  if (!all.every((r) => checkActionCriteria(r).pass)) exitCode = 1;
} finally {
  await agent.close();
  await fixtures.cleanup();
}
process.exit(exitCode);
