import { checkMemoryCriteria, evalNamespace, evaluateApplyCases, evaluateMemoryCases, formatMemoryReport } from "../../evals/memory.js";
import { loadEnv } from "../config/env.js";
import { createAgent } from "../graph/create-agent.js";

// Evalúa la memoria de largo plazo con el modelo real contra los escenarios congelados G1 a G8 y A1 a A4
// (evals/memory-cases.ts). Usa un namespace de memoria propio (no toca las memorias del negocio), solo propone
// acciones (nunca las aprueba) y borra sus hilos. Gasta API (centavos con Haiku).
// Uso: npm run eval:memory            (una corrida)
//      npm run eval:memory -- --runs 3
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

const agent = createAgent(env, { memoryNamespace: evalNamespace() });
let passed = 0;
try {
  for (let run = 1; run <= runs; run++) {
    if (runs > 1) console.log(`\n=== Corrida ${run} de ${runs} ===`);
    const memory = await evaluateMemoryCases(agent);
    const apply = await evaluateApplyCases(agent);
    console.log(formatMemoryReport(memory, apply));
    if (checkMemoryCriteria(memory, apply).pass) passed++;
  }
} finally {
  await agent.close();
}
if (runs > 1) console.log(`\nCorridas que cumplen: ${passed}/${runs}`);
process.exit(passed === runs ? 0 : 1);
