import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnvFile, parseEnv } from "../src/config/env.js";
import { ACTIONS_STATEMENT_TIMEOUT_MS, createPrisma } from "../src/db/client.js";
import { claude } from "../src/graph/models.js";
import { streamContinueTurn, streamRunTurn, TurnTimeoutError } from "../src/graph/run-turn.js";
import { getStatus } from "../src/graph/threads.js";
import { MemoryTraceStore } from "../src/observability/store.js";
import { isTransient } from "../src/tools/retry.js";
import { safeTool } from "../src/tools/safe.js";
import type { UiEvent } from "../src/web/events.js";
import { makeHandlers } from "../src/web/handlers.js";
import { readSse } from "../src/web/sse.js";
import { buildTestGraph } from "./helpers/graph.js";
import { StreamingChatModel } from "./helpers/models.js";

// Fase 12 (T4, CA3): los límites de tiempo de una llamada al modelo, de una consulta a la base y de un turno.

const BASE_ENV = {
  ANTHROPIC_API_KEY: "sk-ant-prueba",
  DATABASE_URL_READ: "postgresql://a:b@localhost/x",
  DATABASE_URL_CHECKPOINTS: "postgresql://a:b@localhost/x",
  DATABASE_URL_ACTIONS: "postgresql://a:b@localhost/x",
};
const LONG = "Una respuesta muy larga que se escribe de a poco, palabra por palabra, para que el turno tarde más que su límite.";

async function all(events: AsyncIterable<UiEvent>) {
  const out: UiEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("los límites de operación en la configuración", () => {
  it("tienen valores por defecto, y se pueden cambiar", () => {
    expect(parseEnv(BASE_ENV)).toMatchObject({ DAILY_BUDGET_USD: 1, MODEL_TIMEOUT_MS: 60_000, TURN_TIMEOUT_MS: 180_000, LOG_RETENTION_DAYS: 14 });
    expect(parseEnv({ ...BASE_ENV, MODEL_TIMEOUT_MS: "5000", DAILY_BUDGET_USD: "0" })).toMatchObject({ MODEL_TIMEOUT_MS: 5000, DAILY_BUDGET_USD: 0 });
    expect(() => parseEnv({ ...BASE_ENV, TURN_TIMEOUT_MS: "nada" })).toThrow(/TURN_TIMEOUT_MS/);
  });

  it("cada modelo de Claude corta una llamada que no responde a los MODEL_TIMEOUT_MS", () => {
    const model = claude(parseEnv({ ...BASE_ENV, MODEL_TIMEOUT_MS: "1234" }), "claude-haiku-5-5");
    expect(model.clientOptions.timeout).toBe(1234);
  });
});

describe("el límite de tiempo de un turno", () => {
  it("un turno que se pasa se corta con un motivo; el hilo queda a medias y «Continuar» lo termina", async () => {
    const traces = new MemoryTraceStore();
    const graph = buildTestGraph({ model: new StreamingChatModel([new AIMessage(LONG), new AIMessage("Listo.")], { delayMs: 30 }), tools: [], intent: "chat", checkpointer: new MemorySaver() });
    await expect(all(streamRunTurn({ graph, traces, limits: { turnTimeoutMs: 150 } }, "h", "contame"))).rejects.toBeInstanceOf(TurnTimeoutError);
    expect((await getStatus(graph, "h")).pending).toBe(true);
    expect(traces.traces[0]).toMatchObject({ status: "pending" });
    expect(traces.traces[0]!.error).toMatch(/TurnTimeoutError: El turno superó el límite de 0 s/);

    const done = (await all(streamContinueTurn({ graph, limits: { turnTimeoutMs: 10_000 } }, "h"))).at(-1);
    expect(done).toMatchObject({ type: "done", result: { reply: "Listo." } });
  });

  it("en la web, el corte llega como un error con su motivo y el hilo queda para continuar", async () => {
    const graph = buildTestGraph({ model: new StreamingChatModel([new AIMessage(LONG)], { delayMs: 30 }), tools: [], intent: "chat", checkpointer: new MemorySaver() });
    const handlers = makeHandlers({ graph, listThreads: async () => [], limits: { turnTimeoutMs: 150 }, log: vi.fn() });
    const origin = "http://127.0.0.1:3000";
    const response = await handlers.postMessage(
      new Request(`${origin}/api/threads/h/messages`, { method: "POST", headers: { "content-type": "application/json", origin, host: "127.0.0.1:3000" }, body: JSON.stringify({ text: "contame" }) }),
      "h",
    );
    const events: UiEvent[] = [];
    for await (const e of readSse(response.body!)) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "error", pending: true });
    expect(events.at(-1)!.type === "error" && events.at(-1)).toMatchObject({ message: expect.stringMatching(/superó el límite/) });
  });

  it("sin límite configurado, un turno largo termina igual", async () => {
    const graph = buildTestGraph({ model: new StreamingChatModel([new AIMessage("Hola.")], { delayMs: 5 }), tools: [], intent: "chat", checkpointer: new MemorySaver() });
    expect((await all(streamRunTurn({ graph }, "h", "hola"))).at(-1)).toMatchObject({ type: "done" });
  });
});

loadEnvFile();
const readUrl = process.env.DATABASE_URL_READ;
const actionsUrl = process.env.DATABASE_URL_ACTIONS;

describe.skipIf(!readUrl || !actionsUrl)("el límite de una consulta a la base (statement_timeout)", () => {
  const reader = new pg.Client({ connectionString: readUrl });
  const actions = new pg.Client({ connectionString: actionsUrl });
  beforeAll(async () => {
    await reader.connect();
    await actions.connect();
  });
  afterAll(async () => {
    await reader.end();
    await actions.end();
  });

  it("las conexiones de la aplicación (createPrisma) tienen su límite por consulta, también por el pooler de Supabase", async () => {
    for (const [url, options, expected] of [
      [readUrl!, {}, "10s"],
      [actionsUrl!, { statementTimeoutMs: ACTIONS_STATEMENT_TIMEOUT_MS }, "5s"],
    ] as const) {
      const db = createPrisma(url, options);
      try {
        const rows = await db.$queryRawUnsafe<{ st: string }[]>("SELECT current_setting('statement_timeout') AS st");
        expect(rows[0]!.st).toBe(expected);
      } finally {
        await db.$disconnect();
      }
    }
  });

  it.skipIf(!process.env.DATABASE_URL_WRITE)("los roles también lo tienen, para las conexiones directas (db:roles y la migración de la fase 5)", async () => {
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL_WRITE });
    await admin.connect();
    try {
      const { rows } = await admin.query("SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('copilot_reader', 'copilot_actions') ORDER BY rolname");
      const config = Object.fromEntries(rows.map((r) => [r.rolname, r.rolconfig]));
      expect(config.copilot_reader).toContain("statement_timeout=10s");
      expect(config.copilot_actions, "el de la fase 5, sin tocar").toContain("statement_timeout=5s");
    } finally {
      await admin.end();
    }
  });

  it("una consulta que se pasa se corta (57014), no se reintenta, y la herramienta lo informa como falla", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // El mismo mecanismo, con un límite corto para que el test no tarde 10 s.
    const slow = async () => {
      await reader.query("BEGIN");
      try {
        await reader.query("SET LOCAL statement_timeout = '100ms'");
        return await reader.query("SELECT pg_sleep(1)");
      } finally {
        await reader.query("ROLLBACK");
      }
    };
    const error = await slow().then(() => undefined, (e: unknown) => e);
    expect(error).toMatchObject({ code: "57014" });
    expect(isTransient(error)).toBe(false);
    let calls = 0;
    const tool = safeTool("getStockLevels", async () => {
      calls++;
      return slow();
    });
    await expect(tool({})).rejects.toThrow(/problema del sistema \(código 57014\)/);
    expect(calls, "no se reintenta").toBe(1);
    vi.restoreAllMocks();
  });
});
