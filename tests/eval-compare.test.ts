import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { promptsDir, readPrompt } from "../src/graph/prompts/read.js";
import { byCase, byCategory, compareRuns, summarize, type EvalCaseResult, type EvalRun } from "../src/observability/eval-report.js";
import { PostgresEvalStore } from "../src/observability/evals-store.js";
import { checkpointsUrl, openCheckpointing } from "./helpers/checkpointing.js";

// Fase 11 (T6: CA5 sin modelo real): el informe de una corrida, la comparación de dos y otra versión de los prompts.

const result = (caseId: string, category: string, passed: boolean, runNo = 1, over: Partial<EvalCaseResult> = {}): EvalCaseResult => ({
  caseId,
  category,
  runNo,
  passed,
  results: passed ? [{ check: "route", ok: true, detail: "ok" }] : [{ check: "route", ok: false, detail: `falló ${caseId}` }],
  reply: "",
  inputTokens: 1000,
  outputTokens: 100,
  costUsd: 0.001,
  durationMs: 2000,
  ...over,
});
const run = (results: EvalCaseResult[], over: Partial<EvalRun> = {}): EvalRun => ({
  id: randomUUID(),
  startedAt: new Date().toISOString(),
  durationMs: 1,
  models: { agent: "claude-haiku-5-5", router: "claude-haiku-5-5", report: "claude-haiku-5-5" },
  prompts: "actuales",
  runs: Math.max(...results.map((r) => r.runNo)),
  ...summarize(results),
  results,
  ...over,
});

describe("el informe de una corrida", () => {
  it("aciertos por categoría, en el orden pedido, sin categorías vacías", () => {
    const results = [result("Q1", "consultas", true), result("Q2", "consultas", false), result("A1", "acciones", true)];
    expect(byCategory(results, ["acciones", "consultas", "reportes"])).toEqual([
      { category: "acciones", passed: 1, total: 1 },
      { category: "consultas", passed: 1, total: 2 },
    ]);
    expect(summarize(results)).toMatchObject({ passed: 2, total: 3, inputTokens: 3000 });
  });

  it("con varias corridas: los inestables y el resultado por mayoría (o empate)", () => {
    const cases = byCase([
      result("Q1", "consultas", true, 1),
      result("Q1", "consultas", false, 2),
      result("Q1", "consultas", true, 3),
      result("H1", "charla", false, 1),
      result("H1", "charla", true, 2),
      result("X1", "mixtos", false, 1, { error: "Error: se cayó" }),
      result("X1", "mixtos", false, 2),
    ]);
    expect(cases.map((c) => [c.caseId, c.passes, c.runs, c.unstable, c.outcome])).toEqual([
      ["Q1", 2, 3, true, "pasa"],
      ["H1", 1, 2, true, "empate"],
      ["X1", 0, 2, false, "falla"],
    ]);
    expect(cases[2]!.failures).toEqual(["Error: se cayó", "falló X1"]);
  });
});

describe("comparar dos corridas", () => {
  it("los casos que cambiaron por mayoría, en qué dirección, y la diferencia por caso", () => {
    const a = run([result("Q1", "consultas", true), result("X1", "mixtos", true), result("H1", "charla", false), result("T1", "contexto", true)]);
    const b = run([
      result("Q1", "consultas", true, 1, { inputTokens: 1200 }),
      result("X1", "mixtos", false, 1, { inputTokens: 1200 }),
      result("H1", "charla", true, 1, { inputTokens: 1200 }),
      result("T1", "contexto", true, 1, { inputTokens: 1200 }),
    ]);
    const cmp = compareRuns(a, b, ["consultas", "mixtos", "charla", "contexto"]);
    expect(cmp.changed.map((c) => [c.caseId, c.direction])).toEqual([
      ["X1", "empeoró"],
      ["H1", "mejoró"],
    ]);
    expect(cmp.categories.find((c) => c.category === "mixtos")).toMatchObject({ a: { passed: 1 }, b: { passed: 0 } });
    expect(cmp.delta.inputTokens).toBe(200);
    expect(cmp.a).not.toHaveProperty("results");
  });

  it("el azar no cuenta como cambio: un empate o una corrida suelta contra una mayoría igual no cambian", () => {
    const a = run([result("Q1", "consultas", true, 1), result("Q1", "consultas", true, 2), result("Q1", "consultas", false, 3)]);
    const b = run([result("Q1", "consultas", true, 1), result("Q1", "consultas", false, 2), result("Q1", "consultas", true, 3)]);
    const tie = run([result("Q1", "consultas", true, 1), result("Q1", "consultas", false, 2)]);
    expect(compareRuns(a, b).changed).toEqual([]);
    expect(compareRuns(a, tie).changed).toEqual([]);
  });

  it("solo compara los casos que están en las dos (por ejemplo, una con --only)", () => {
    const a = run([result("Q1", "consultas", true), result("A1", "acciones", true)]);
    const b = run([result("Q1", "consultas", false)]);
    const cmp = compareRuns(a, b);
    expect(cmp.categories.map((c) => c.category)).toEqual(["consultas"]);
    expect(cmp.changed.map((c) => c.caseId)).toEqual(["Q1"]);
  });
});

describe("otra versión de los prompts (COPILOT_PROMPTS_DIR)", () => {
  const dir = mkdtempSync(join(tmpdir(), "prompts-"));
  writeFileSync(join(dir, "router.md"), "ROUTER NUEVO");
  const router = new URL("../src/graph/prompts/router.md", import.meta.url);
  const chat = new URL("../src/graph/prompts/chat.md", import.meta.url);
  afterEach(() => {
    delete process.env.COPILOT_PROMPTS_DIR;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("sin la variable, los de siempre", () => {
    expect(promptsDir()).toBeUndefined();
    expect(readPrompt(router)).not.toBe("ROUTER NUEVO");
  });

  it("con la variable, los que tiene la carpeta; el resto, los de siempre", () => {
    process.env.COPILOT_PROMPTS_DIR = dir;
    expect(readPrompt(router)).toBe("ROUTER NUEVO");
    expect(readPrompt(chat)).toContain("charla");
  });

  it("una carpeta que no existe es un error claro", () => {
    process.env.COPILOT_PROMPTS_DIR = join(dir, "no-existe");
    expect(() => readPrompt(router)).toThrow(/no existe/);
  });
});

describe.skipIf(!checkpointsUrl)("las corridas en Postgres", () => {
  const cp = openCheckpointing();
  const store = new PostgresEvalStore(cp.pool);
  const saved: string[] = [];
  afterAll(async () => {
    await cp.pool.query("DELETE FROM observability.eval_runs WHERE id = ANY($1)", [saved]);
    await cp.close();
  });

  it("guarda una corrida con sus casos y la lee igual; la lista trae el resumen, de la más nueva a la más vieja", async () => {
    const r = run([result("Q1", "consultas", true, 1, { traceId: randomUUID() }), result("Q1", "consultas", false, 2, { error: "Error: x" })], { label: "prueba" });
    saved.push(r.id);
    await store.save(r);
    expect(await store.get(r.id)).toEqual(r);
    const list = await store.list(5);
    expect(list[0]).toMatchObject({ id: r.id, label: "prueba", passed: 1, total: 2 });
    expect(list[0]).not.toHaveProperty("results");
    expect(await store.get(randomUUID())).toBeUndefined();
  });
});
