import type pg from "pg";
import type { EvalCaseResult, EvalRun, EvalRunSummary } from "./eval-report.js";
import { isTraceId, OBSERVABILITY_SCHEMA } from "./store.js";

// Las corridas del set de evaluación (fase 11, R11 y R14): en el esquema `observability`, junto a las trazas, para que
// la web las muestre y las compare.

export interface EvalStore {
  save(run: EvalRun): Promise<void>;
  list(limit?: number): Promise<EvalRunSummary[]>;
  get(id: string): Promise<EvalRun | undefined>;
}

const RUN_COLUMNS = "id, label, started_at, duration_ms, models, prompts, runs, passed, total, input_tokens, output_tokens, cost_usd";
type Row = Record<string, unknown>;

const toSummary = (row: Row): EvalRunSummary => ({
  id: String(row.id),
  ...(row.label !== null && { label: String(row.label) }),
  startedAt: new Date(row.started_at as string).toISOString(),
  durationMs: Number(row.duration_ms),
  models: row.models as EvalRunSummary["models"],
  prompts: String(row.prompts),
  runs: Number(row.runs),
  passed: Number(row.passed),
  total: Number(row.total),
  inputTokens: Number(row.input_tokens),
  outputTokens: Number(row.output_tokens),
  costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
});

const toResult = (row: Row): EvalCaseResult => ({
  caseId: String(row.case_id),
  category: String(row.category),
  runNo: Number(row.run_no),
  passed: Boolean(row.passed),
  results: row.checks as EvalCaseResult["results"],
  ...(row.error !== null && { error: String(row.error) }),
  reply: String(row.reply),
  inputTokens: Number(row.input_tokens),
  outputTokens: Number(row.output_tokens),
  costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
  durationMs: Number(row.duration_ms),
  ...(row.trace_id !== null && { traceId: String(row.trace_id) }),
});

export class PostgresEvalStore implements EvalStore {
  constructor(private readonly pool: pg.Pool) {}

  async save(run: EvalRun): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${OBSERVABILITY_SCHEMA}.eval_runs (${RUN_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [run.id, run.label ?? null, run.startedAt, run.durationMs, JSON.stringify(run.models), run.prompts, run.runs, run.passed, run.total, run.inputTokens, run.outputTokens, run.costUsd],
      );
      for (const r of run.results) {
        await client.query(
          `INSERT INTO ${OBSERVABILITY_SCHEMA}.eval_results
             (run_id, case_id, category, run_no, passed, checks, error, reply, input_tokens, output_tokens, cost_usd, duration_ms, trace_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [run.id, r.caseId, r.category, r.runNo, r.passed, JSON.stringify(r.results), r.error ?? null, r.reply, r.inputTokens, r.outputTokens, r.costUsd, r.durationMs, r.traceId ?? null],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(limit = 50): Promise<EvalRunSummary[]> {
    const { rows } = await this.pool.query(`SELECT ${RUN_COLUMNS} FROM ${OBSERVABILITY_SCHEMA}.eval_runs ORDER BY started_at DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 200)]);
    return rows.map(toSummary);
  }

  async get(id: string): Promise<EvalRun | undefined> {
    if (!isTraceId(id)) return undefined;
    const { rows } = await this.pool.query(`SELECT ${RUN_COLUMNS} FROM ${OBSERVABILITY_SCHEMA}.eval_runs WHERE id = $1`, [id]);
    if (!rows[0]) return undefined;
    const results = await this.pool.query(`SELECT * FROM ${OBSERVABILITY_SCHEMA}.eval_results WHERE run_id = $1 ORDER BY case_id, run_no`, [id]);
    return { ...toSummary(rows[0]), results: results.rows.map(toResult) };
  }
}

/** Corridas en memoria: para los tests. */
export class MemoryEvalStore implements EvalStore {
  readonly runs: EvalRun[] = [];
  async save(run: EvalRun) {
    this.runs.push(run);
  }
  async list(limit = 50) {
    return [...this.runs]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map(({ results: _r, ...summary }) => summary);
  }
  async get(id: string) {
    return this.runs.find((r) => r.id === id);
  }
}
