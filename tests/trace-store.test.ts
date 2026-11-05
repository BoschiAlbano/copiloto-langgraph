import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresTraceStore } from "../src/observability/store.js";
import type { Trace } from "../src/observability/trace-recorder.js";
import { checkpointsUrl, openCheckpointing } from "./helpers/checkpointing.js";

// Fase 11 (T3, R4 y R6): las trazas en Postgres, con el rol de los hilos. Requiere `npm run db:observability`.

const readUrl = process.env.DATABASE_URL_READ;

function trace(over: Partial<Trace> = {}): Trace {
  return {
    id: randomUUID(),
    threadId: "test-trazas",
    kind: "new",
    input: "¿stock?",
    startedAt: new Date().toISOString(),
    durationMs: 1200,
    status: "ok",
    route: ["query"],
    calls: 2,
    inputTokens: 200,
    outputTokens: 20,
    costUsd: 0.0003,
    retries: 0,
    spans: [
      { id: "r", kind: "turn", name: "turno", start: 0, duration: 1200, status: "ok" },
      { id: "t", parentId: "r", kind: "tool", name: "getStockLevels", start: 10, duration: 50, status: "ok", args: { query: "cera" }, result: "{}" },
    ],
    ...over,
  };
}

describe.skipIf(!checkpointsUrl)("trazas en Postgres", () => {
  const cp = openCheckpointing();
  const store = new PostgresTraceStore(cp.pool);
  const thread = `test-trazas-${randomUUID().slice(0, 8)}`;
  const other = `${thread}-otro`;

  afterAll(async () => {
    await store.deleteThread(thread);
    await store.deleteThread(other);
    await cp.close();
  });

  it("guarda y lee una traza entera, con su árbol", async () => {
    const t = trace({ threadId: thread });
    await store.save(t);
    await store.save(t); // guardar dos veces la misma no duplica
    expect(await store.get(t.id)).toEqual(t);
    expect(await store.get(randomUUID())).toBeUndefined();
    expect(await store.get("no-es-un-uuid")).toBeUndefined();
  });

  it("lista sin el árbol, de la más nueva a la más vieja, y filtra por hilo, por errores y por corrida", async () => {
    const run = randomUUID();
    const older = trace({ threadId: thread, startedAt: new Date(Date.now() - 60_000).toISOString() });
    const failed = trace({ threadId: thread, status: "error", error: "Error: algo" });
    const stepFailed = trace({ threadId: thread, spans: [{ id: "x", kind: "tool", name: "findClient", start: 0, duration: 1, status: "error" }] });
    const fromEval = trace({ threadId: other, evalRunId: run, evalCaseId: "Q1" });
    for (const t of [older, failed, stepFailed, fromEval]) await store.save(t);

    const mine = await store.list({ threadId: thread });
    expect(mine.length).toBeGreaterThanOrEqual(4);
    expect(mine.at(-1)!.id).toBe(older.id);
    expect(mine[0]).not.toHaveProperty("spans");
    const errors = (await store.list({ threadId: thread, errorsOnly: true })).map((t) => t.id).sort();
    expect(errors).toEqual([failed.id, stepFailed.id].sort());
    expect(await store.list({ evalRunId: run })).toMatchObject([{ id: fromEval.id, evalCaseId: "Q1" }]);
  });

  it("borrar un hilo borra sus trazas; las viejas se borran por antigüedad", async () => {
    const old = trace({ threadId: other, startedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() });
    await store.save(old);
    expect(await store.prune(30)).toBeGreaterThanOrEqual(1);
    expect(await store.get(old.id)).toBeUndefined();
    expect(await store.deleteThread(thread)).toBeGreaterThanOrEqual(4);
    expect(await store.list({ threadId: thread })).toEqual([]);
  });

  it("sin el esquema, lo avisa una sola vez y no rompe", async () => {
    const warn = vi.fn();
    const broken = new PostgresTraceStore({ query: async () => { throw Object.assign(new Error("no existe"), { code: "42P01" }); } } as never, warn);
    await broken.save(trace());
    await broken.save(trace());
    expect(await broken.list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/db:observability/);
  });
});

describe.skipIf(!readUrl)("el rol de solo lectura no ve las trazas (R4)", () => {
  const client = new pg.Client({ connectionString: readUrl });
  beforeAll(() => client.connect());
  afterAll(() => client.end());

  it("copilot_reader no puede leer el esquema observability", async () => {
    await expect(client.query("SELECT COUNT(*) FROM observability.traces")).rejects.toMatchObject({ code: "42501" });
  });
});
