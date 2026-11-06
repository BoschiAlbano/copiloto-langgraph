import { checkCriteria, evaluateClarifications, evaluateRouter, formatReport } from "../../evals/router.js";
import { loadEnvOrExit } from "../config/env.js";
import { makeClarifyModel, makeRouterModel } from "../graph/models.js";

// Evalúa el router con los 30 casos congelados de evals/router-cases.ts.
// Uso: npm run eval:router            (una corrida)
//      npm run eval:router -- --runs 3  (repite para ver si el resultado es estable)
const runsArg = process.argv.indexOf("--runs");
const runs = runsArg === -1 ? 1 : Math.max(1, Number(process.argv[runsArg + 1]) || 1);

const env = loadEnvOrExit();
const router = makeRouterModel(env);
const clarify = makeClarifyModel(env);

console.log(`Router: ${env.MODEL_ROUTER} · ${runs} corrida(s) · 30 casos cada una\n`);

let allPass = true;
const varied = new Map<string, Set<string>>();
for (let run = 1; run <= runs; run++) {
  const results = await evaluateRouter(router);
  const clarifications = await evaluateClarifications(clarify);
  allPass &&= checkCriteria(results, clarifications).pass;
  for (const r of results) {
    const seen = varied.get(r.case.id) ?? new Set<string>();
    seen.add(r.actual);
    varied.set(r.case.id, seen);
  }
  console.log(`=== Corrida ${run} ===\n${formatReport(results, clarifications)}`);
  const notQuestions = clarifications.filter((q) => !q.isQuestion);
  for (const q of notQuestions) console.log(`  aclaración sin "?" final en ${q.caseId}: ${q.question}`);
  console.log("");
}

const unstable = [...varied].filter(([, seen]) => seen.size > 1);
if (unstable.length) {
  console.log("Casos inestables entre corridas:");
  for (const [id, seen] of unstable) console.log(`  ${id}: ${[...seen].join(" / ")}`);
}
console.log(`Resultado global: ${allPass ? "CUMPLE en todas las corridas" : "NO cumple en alguna corrida"}`);
process.exit(allPass ? 0 : 1);
