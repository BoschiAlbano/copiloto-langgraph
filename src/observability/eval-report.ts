// Los informes de las evaluaciones (fase 11, R11, R13 y R14): funciones puras sobre los resultados de una corrida, que
// usan la terminal y la web. Sin la base ni el modelo.

/** Una regla de un caso, como quedó en la corrida. */
export interface CheckOutcome {
  check: string;
  ok: boolean;
  detail: string;
}

/** Un caso en una corrida (con `--runs N`, hay N por caso). */
export interface EvalCaseResult {
  caseId: string;
  category: string;
  runNo: number;
  passed: boolean;
  results: CheckOutcome[];
  error?: string;
  reply: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
  traceId?: string;
}

export interface EvalRunSummary {
  id: string;
  label?: string;
  startedAt: string;
  durationMs: number;
  models: { agent: string; router: string; report: string };
  /** La versión de los prompts: la carpeta de `COPILOT_PROMPTS_DIR`, o «actuales». */
  prompts: string;
  runs: number;
  passed: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface EvalRun extends EvalRunSummary {
  results: EvalCaseResult[];
}

export interface CategoryScore {
  category: string;
  passed: number;
  total: number;
}

/** Aciertos por categoría (cada caso en cada corrida cuenta una vez), en el orden de `order` si se da. */
export function byCategory(results: EvalCaseResult[], order: readonly string[] = []): CategoryScore[] {
  const scores = new Map<string, CategoryScore>();
  for (const category of order) scores.set(category, { category, passed: 0, total: 0 });
  for (const r of results) {
    const score = scores.get(r.category) ?? { category: r.category, passed: 0, total: 0 };
    score.total += 1;
    if (r.passed) score.passed += 1;
    scores.set(r.category, score);
  }
  return [...scores.values()].filter((s) => s.total > 0);
}

/** Cómo le fue a un caso en todas las corridas. */
export interface CaseScore {
  caseId: string;
  category: string;
  passes: number;
  runs: number;
  /** Pasó en unas corridas y falló en otras. */
  unstable: boolean;
  /** «pasa» o «falla» si una de las dos es mayoría; si empatan, no hay resultado claro. */
  outcome: "pasa" | "falla" | "empate";
  /** Las reglas que fallaron en alguna corrida (sin repetir) o el error del sistema. */
  failures: string[];
}

export function byCase(results: EvalCaseResult[]): CaseScore[] {
  const cases = new Map<string, EvalCaseResult[]>();
  for (const r of results) cases.set(r.caseId, [...(cases.get(r.caseId) ?? []), r]);
  return [...cases.entries()].map(([caseId, runs]) => {
    const passes = runs.filter((r) => r.passed).length;
    const failures = [...new Set(runs.flatMap((r) => (r.error ? [r.error] : r.results.filter((c) => !c.ok).map((c) => c.detail))))];
    return {
      caseId,
      category: runs[0]!.category,
      passes,
      runs: runs.length,
      unstable: passes > 0 && passes < runs.length,
      outcome: passes * 2 > runs.length ? "pasa" : passes * 2 < runs.length ? "falla" : "empate",
      failures,
    };
  });
}

export interface RunComparison {
  a: EvalRunSummary;
  b: EvalRunSummary;
  categories: { category: string; a: CategoryScore; b: CategoryScore }[];
  /** Los casos cuyo resultado mayoritario cambió (pasaba y falla, o al revés). Un empate no cuenta como cambio. */
  changed: { caseId: string; category: string; a: CaseScore; b: CaseScore; direction: "mejoró" | "empeoró" }[];
  /** Diferencia de B respecto de A, por corrida de cada caso (para que `--runs` distintos se puedan comparar). */
  delta: { inputTokens: number; outputTokens: number; costUsd: number | null };
}

const perRun = (run: EvalRun, key: "inputTokens" | "outputTokens") => (run.results.length ? run.results.reduce((n, r) => n + r[key], 0) / run.results.length : 0);
const costPerRun = (run: EvalRun) => (run.results.some((r) => r.costUsd === null) || !run.results.length ? null : run.results.reduce((n, r) => n + (r.costUsd ?? 0), 0) / run.results.length);

/** Compara dos corridas (A, la de antes; B, la nueva) sobre los casos que tienen las dos. */
export function compareRuns(a: EvalRun, b: EvalRun, order: readonly string[] = []): RunComparison {
  const casesA = new Map(byCase(a.results).map((c) => [c.caseId, c]));
  const casesB = new Map(byCase(b.results).map((c) => [c.caseId, c]));
  const shared = [...casesA.keys()].filter((id) => casesB.has(id));
  const sharedSet = new Set(shared);
  const catA = byCategory(a.results.filter((r) => sharedSet.has(r.caseId)), order);
  const catB = new Map(byCategory(b.results.filter((r) => sharedSet.has(r.caseId)), order).map((s) => [s.category, s]));
  const changed = shared
    .map((id) => ({ ca: casesA.get(id)!, cb: casesB.get(id)! }))
    .filter(({ ca, cb }) => ca.outcome !== "empate" && cb.outcome !== "empate" && ca.outcome !== cb.outcome)
    .map(({ ca, cb }) => ({ caseId: ca.caseId, category: ca.category, a: ca, b: cb, direction: cb.outcome === "pasa" ? ("mejoró" as const) : ("empeoró" as const) }));
  const costA = costPerRun(a);
  const costB = costPerRun(b);
  const { results: _ra, ...summaryA } = a;
  const { results: _rb, ...summaryB } = b;
  return {
    a: summaryA,
    b: summaryB,
    categories: catA.map((s) => ({ category: s.category, a: s, b: catB.get(s.category) ?? { category: s.category, passed: 0, total: 0 } })),
    changed,
    delta: {
      inputTokens: Math.round(perRun(b, "inputTokens") - perRun(a, "inputTokens")),
      outputTokens: Math.round(perRun(b, "outputTokens") - perRun(a, "outputTokens")),
      costUsd: costA === null || costB === null ? null : costB - costA,
    },
  };
}

/** El resumen de una corrida a partir de sus resultados. */
export function summarize(results: EvalCaseResult[]): Pick<EvalRunSummary, "passed" | "total" | "inputTokens" | "outputTokens" | "costUsd"> {
  return {
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    inputTokens: results.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: results.reduce((n, r) => n + r.outputTokens, 0),
    costUsd: results.some((r) => r.costUsd === null) ? null : results.reduce((n, r) => n + (r.costUsd ?? 0), 0),
  };
}

export const percent = (passed: number, total: number) => (total ? `${Math.round((passed / total) * 100)} %` : "—");
