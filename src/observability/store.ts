import pg from "pg";
import { parseThreadId } from "../graph/thread-id.js";
import type { Trace, TraceStatus, TurnKind } from "./trace-recorder.js";
import { log } from "../ops/log.js";

// Dónde se guardan las trazas (fase 11, R3, R4 y R6): en el mismo Postgres que los hilos, con el mismo rol
// (`copilot_checkpointer`), en el esquema `observability` que crea `npm run db:observability`.

export const OBSERVABILITY_SCHEMA = "observability";

/** Lo que necesita un turno para dejar su traza (`streamInvoke`). */
export interface TraceSink {
  save(trace: Trace): Promise<void>;
}

/** Una traza en la lista: todo menos el árbol de pasos. */
export type TraceSummary = Omit<Trace, "spans">;

export interface TraceFilter {
  threadId?: string;
  /** Solo las que terminaron con error o tuvieron un paso con error. */
  errorsOnly?: boolean;
  evalRunId?: string;
  limit?: number;
}

export interface TraceStore extends TraceSink {
  list(filter?: TraceFilter): Promise<TraceSummary[]>;
  get(id: string): Promise<Trace | undefined>;
  deleteThread(threadId: string): Promise<number>;
  /** Borra las trazas de más de `days` días. Devuelve cuántas borró. */
  prune(days: number): Promise<number>;
  /** Lo que costaron los turnos desde ese momento, sin las corridas de evaluación (fase 12: el tope de gasto). */
  costSince(since: Date): Promise<number>;
}

const SUMMARY_COLUMNS = `id, thread_id, kind, input, started_at, duration_ms, status, error, route, calls, input_tokens, output_tokens,
  cost_usd, retries, eval_run_id, eval_case_id`;

type Row = Record<string, unknown>;

function toSummary(row: Row): TraceSummary {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    kind: row.kind as TurnKind,
    ...(row.input !== null && { input: String(row.input) }),
    startedAt: new Date(row.started_at as string).toISOString(),
    durationMs: Number(row.duration_ms),
    status: row.status as TraceStatus,
    ...(row.error !== null && { error: String(row.error) }),
    route: (row.route as string[]) ?? [],
    calls: Number(row.calls),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    retries: Number(row.retries),
    ...(row.eval_run_id !== null && { evalRunId: String(row.eval_run_id) }),
    ...(row.eval_case_id !== null && { evalCaseId: String(row.eval_case_id) }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isTraceId = (id: string) => UUID.test(id);

/** Las trazas en Postgres. Si el esquema no existe (falta `db:observability`), lo avisa una sola vez. */
export class PostgresTraceStore implements TraceStore {
  private warned = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly warn: (message: string) => void = (m) => log.warn("trazas-sin-esquema", m),
  ) {}

  private missingSchema(error: unknown): boolean {
    if ((error as { code?: string }).code !== "42P01" && (error as { code?: string }).code !== "3F000") return false;
    if (!this.warned) this.warn("[trazas] No existe el esquema de las trazas: corré `npm run db:observability`. Los turnos siguen sin trazas.");
    this.warned = true;
    return true;
  }

  async save(trace: Trace): Promise<void> {
    const { spans, ...t } = trace;
    try {
      await this.pool.query(
        `INSERT INTO ${OBSERVABILITY_SCHEMA}.traces (${SUMMARY_COLUMNS}, spans)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO NOTHING`,
        [
          t.id, t.threadId, t.kind, t.input ?? null, t.startedAt, t.durationMs, t.status, t.error ?? null, t.route, t.calls,
          t.inputTokens, t.outputTokens, t.costUsd, t.retries, t.evalRunId ?? null, t.evalCaseId ?? null, JSON.stringify(spans),
        ],
      );
    } catch (error) {
      if (!this.missingSchema(error)) throw error;
    }
  }

  async list(filter: TraceFilter = {}): Promise<TraceSummary[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.threadId) where.push(`thread_id = $${values.push(parseThreadId(filter.threadId))}`);
    if (filter.evalRunId) where.push(`eval_run_id = $${values.push(filter.evalRunId)}`);
    if (filter.errorsOnly) where.push(`(status = 'error' OR spans @> '[{"status": "error"}]')`);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    try {
      const { rows } = await this.pool.query(
        `SELECT ${SUMMARY_COLUMNS} FROM ${OBSERVABILITY_SCHEMA}.traces ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY started_at DESC LIMIT ${limit}`,
        values,
      );
      return rows.map(toSummary);
    } catch (error) {
      if (this.missingSchema(error)) return [];
      throw error;
    }
  }

  async get(id: string): Promise<Trace | undefined> {
    if (!isTraceId(id)) return undefined;
    try {
      const { rows } = await this.pool.query(`SELECT ${SUMMARY_COLUMNS}, spans FROM ${OBSERVABILITY_SCHEMA}.traces WHERE id = $1`, [id]);
      const row = rows[0];
      return row ? { ...toSummary(row), spans: row.spans } : undefined;
    } catch (error) {
      if (this.missingSchema(error)) return undefined;
      throw error;
    }
  }

  async deleteThread(threadId: string): Promise<number> {
    try {
      const { rowCount } = await this.pool.query(`DELETE FROM ${OBSERVABILITY_SCHEMA}.traces WHERE thread_id = $1`, [parseThreadId(threadId)]);
      return rowCount ?? 0;
    } catch (error) {
      if (this.missingSchema(error)) return 0;
      throw error;
    }
  }

  async prune(days: number): Promise<number> {
    try {
      const { rowCount } = await this.pool.query(`DELETE FROM ${OBSERVABILITY_SCHEMA}.traces WHERE started_at < now() - make_interval(days => $1)`, [days]);
      return rowCount ?? 0;
    } catch (error) {
      if (this.missingSchema(error)) return 0;
      throw error;
    }
  }

  async costSince(since: Date): Promise<number> {
    try {
      const { rows } = await this.pool.query(
        `SELECT COALESCE(SUM(cost_usd), 0)::float AS usd FROM ${OBSERVABILITY_SCHEMA}.traces WHERE started_at >= $1 AND eval_run_id IS NULL`,
        [since.toISOString()],
      );
      return Number(rows[0]?.usd ?? 0);
    } catch (error) {
      if (this.missingSchema(error)) return 0;
      throw error;
    }
  }
}

/** Trazas en memoria: para los tests y para correr sin base. */
export class MemoryTraceStore implements TraceStore {
  readonly traces: Trace[] = [];

  async save(trace: Trace) {
    this.traces.push(trace);
  }

  async list(filter: TraceFilter = {}) {
    return this.traces
      .filter((t) => !filter.threadId || t.threadId === filter.threadId)
      .filter((t) => !filter.evalRunId || t.evalRunId === filter.evalRunId)
      .filter((t) => !filter.errorsOnly || t.status === "error" || t.spans.some((s) => s.status === "error"))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, filter.limit ?? 50)
      .map(({ spans: _spans, ...summary }) => summary);
  }

  async get(id: string) {
    return this.traces.find((t) => t.id === id);
  }

  async deleteThread(threadId: string) {
    const before = this.traces.length;
    this.traces.splice(0, this.traces.length, ...this.traces.filter((t) => t.threadId !== threadId));
    return before - this.traces.length;
  }

  async prune(days: number) {
    const limit = Date.now() - days * 24 * 60 * 60 * 1000;
    const before = this.traces.length;
    this.traces.splice(0, this.traces.length, ...this.traces.filter((t) => Date.parse(t.startedAt) >= limit));
    return before - this.traces.length;
  }

  async costSince(since: Date) {
    return this.traces.filter((t) => !t.evalRunId && Date.parse(t.startedAt) >= since.getTime()).reduce((n, t) => n + (t.costUsd ?? 0), 0);
  }
}
