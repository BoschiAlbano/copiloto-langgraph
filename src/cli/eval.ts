import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { CATEGORIES, conversationCases } from "../../evals/conversation-cases.js";
import { runCase } from "../../evals/conversation.js";
import { evalNamespace } from "../../evals/memory.js";
import { loadEnvOrExit } from "../config/env.js";
import { createAgent } from "../graph/create-agent.js";
import { promptsDir } from "../graph/prompts/read.js";
import { byCase, byCategory, compareRuns, percent, summarize, type EvalCaseResult, type EvalRun } from "../observability/eval-report.js";
import { usd } from "./format.js";

// El set de evaluación de punta a punta (fase 11, R10 a R13). Corre con los modelos del .env y gasta API (centavos con
// Haiku). No escribe datos del negocio: las acciones se proponen y se rechazan solas.
//
//   npm run eval                                   una corrida de los 36 casos
//   npm run eval -- --runs 3                       tres corridas (para ver los casos inestables)
//   npm run eval -- --only acciones               solo una categoría
//   npm run eval -- --label "antes del cambio"     con nombre
//   npm run eval -- --json resultados.json         además, en un archivo
//   npm run eval -- --compare evals/prompts/x      los prompts actuales contra los de esa carpeta (dos corridas)

const WEB = "http://127.0.0.1:3000";
const RUN_MARK = "EVAL_RUN_ID=";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}
const runs = Math.max(1, Number(arg("runs")) || 1);
const only = arg("only");
const label = arg("label");
const json = arg("json");
const compare = arg("compare");
const isChild = process.argv.includes("--child");

if (only && !(CATEGORIES as readonly string[]).includes(only)) {
  console.error(`Categoría desconocida: «${only}». Las categorías son: ${CATEGORIES.join(", ")}.`);
  process.exit(1);
}

if (compare) await runComparison(compare);
else await runSet();

/** Una corrida del set: los casos en orden, N veces; el informe; la corrida en Postgres. */
async function runSet() {
  const env = loadEnvOrExit();
  const prompts = promptsDir() ?? "actuales";
  const agent = createAgent(env, { memoryNamespace: evalNamespace() });
  const reader = new pg.Client({ connectionString: env.DATABASE_URL_READ });
  await reader.connect();
  await reader.query("SET default_transaction_read_only = on");
  const sql = async (text: string) => (await reader.query({ text, rowMode: "array" })).rows.map((r: unknown[]) => r[0]);

  const runId = randomUUID();
  const started = Date.now();
  const cases = conversationCases().filter((c) => !only || c.category === only);
  console.log(`Evaluación: ${cases.length} casos × ${runs} corrida(s) · agente ${env.MODEL_AGENT} · router ${env.MODEL_ROUTER} · prompts ${prompts}\n`);

  const results: EvalCaseResult[] = [];
  try {
    for (let runNo = 1; runNo <= runs; runNo++) {
      if (runs > 1) console.log(`=== Corrida ${runNo} ===`);
      for (const c of cases) {
        const r = await runCase(c, runNo, {
          agent,
          traces: (caseId) => ({ save: (t) => agent.traces.save({ ...t, evalRunId: runId, evalCaseId: caseId }) }),
          memory: agent.memory,
          sql,
          runTag: runId.slice(0, 8),
        });
        results.push(r);
        const why = r.error ?? r.results.filter((x) => !x.ok).map((x) => x.detail).join("; ");
        console.log(`  ${r.passed ? "✓" : "✗"} ${c.id.padEnd(3)} ${c.category.padEnd(22)} ${(r.durationMs / 1000).toFixed(1).padStart(5)} s  ${why}`);
      }
    }
    const run: EvalRun = {
      id: runId,
      ...(label && { label }),
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      models: { agent: env.MODEL_AGENT, router: env.MODEL_ROUTER, report: env.MODEL_REPORT },
      prompts,
      runs,
      ...summarize(results),
      results,
    };
    await agent.evals.save(run);
    printReport(run);
    if (json) {
      writeFileSync(json, JSON.stringify(run, null, 2));
      console.log(`Exportado a ${json}.`);
    }
    console.log(`\nEn la web: ${WEB}/evals/${runId}`);
    if (isChild) console.log(`${RUN_MARK}${runId}`);
  } finally {
    await reader.end();
    await agent.close();
  }
}

function printReport(run: EvalRun) {
  console.log(`\nAciertos por categoría:`);
  for (const s of byCategory(run.results, CATEGORIES)) console.log(`  ${s.category.padEnd(24)} ${String(s.passed).padStart(3)}/${s.total}  ${percent(s.passed, s.total)}`);
  console.log(`  ${"TOTAL".padEnd(24)} ${String(run.passed).padStart(3)}/${run.total}  ${percent(run.passed, run.total)}`);
  const cases = byCase(run.results);
  const unstable = cases.filter((c) => c.unstable);
  if (unstable.length) console.log(`\nInestables (pasan en unas corridas y en otras no): ${unstable.map((c) => `${c.caseId} (${c.passes}/${c.runs})`).join(", ")}`);
  console.log(`\n${run.inputTokens} → ${run.outputTokens} tokens · ${usd(run.costUsd)} · ${(run.durationMs / 1000).toFixed(0)} s`);
}

/** Los prompts actuales contra otra versión: dos corridas, cada una en su proceso (los prompts se leen al arrancar). */
async function runComparison(dir: string) {
  const forward = process.argv.slice(2).filter((a, i, all) => a !== "--compare" && all[i - 1] !== "--compare" && a !== "--label" && all[i - 1] !== "--label");
  const child = (prompts: string | undefined, name: string) => {
    console.log(`\n##### ${name} #####`);
    const env = { ...process.env };
    if (prompts) env.COPILOT_PROMPTS_DIR = prompts;
    else delete env.COPILOT_PROMPTS_DIR;
    const out = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, ...forward, "--child", "--label", `${label ? `${label}: ` : ""}${name}`], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const text = out.stdout ?? "";
    process.stdout.write(text.split("\n").filter((l) => !l.startsWith(RUN_MARK)).join("\n"));
    const id = text.split("\n").find((l) => l.startsWith(RUN_MARK))?.slice(RUN_MARK.length).trim();
    if (out.status !== 0 || !id) throw new Error(`La corrida «${name}» no terminó (código ${out.status}).`);
    return id;
  };
  const a = child(undefined, "prompts actuales");
  const b = child(dir, `prompts de ${dir}`);

  const env = loadEnvOrExit();
  const agent = createAgent(env);
  try {
    const [runA, runB] = await Promise.all([agent.evals.get(a), agent.evals.get(b)]);
    if (!runA || !runB) throw new Error("No se encontraron las dos corridas en la base.");
    const cmp = compareRuns(runA, runB, CATEGORIES);
    console.log(`\n##### Comparación #####\n`);
    console.log(`${"categoría".padEnd(24)} ${"actuales".padStart(10)} ${"nueva".padStart(10)}`);
    for (const c of cmp.categories) {
      const arrow = c.b.passed === c.a.passed ? " " : c.b.passed > c.a.passed ? "▲" : "▼";
      console.log(`${c.category.padEnd(24)} ${`${c.a.passed}/${c.a.total}`.padStart(10)} ${`${c.b.passed}/${c.b.total}`.padStart(10)} ${arrow}`);
    }
    console.log(cmp.changed.length ? `\nCasos que cambiaron (en la mayoría de las corridas):` : `\nNingún caso cambió de forma estable.`);
    for (const c of cmp.changed) console.log(`  ${c.direction === "mejoró" ? "▲" : "▼"} ${c.caseId} (${c.category}): ${c.a.passes}/${c.a.runs} → ${c.b.passes}/${c.b.runs}${c.direction === "empeoró" && c.b.failures.length ? ` · ${c.b.failures[0]}` : ""}`);
    const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
    console.log(`\nPor caso: ${sign(cmp.delta.inputTokens)} tokens de entrada, ${sign(cmp.delta.outputTokens)} de salida, ${cmp.delta.costUsd === null ? "costo desconocido" : `${cmp.delta.costUsd >= 0 ? "+" : "-"}${usd(Math.abs(cmp.delta.costUsd))}`}`);
    console.log(`\nEn la web: ${WEB}/evals/compare?a=${a}&b=${b}`);
  } finally {
    await agent.close();
  }
}
