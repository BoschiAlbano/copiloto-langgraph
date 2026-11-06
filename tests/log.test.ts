import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { streamRunTurn } from "../src/graph/run-turn.js";
import { createLogger, errorData, pruneLogs, redact } from "../src/ops/log.js";
import { safeTool } from "../src/tools/safe.js";
import type { UiEvent } from "../src/web/events.js";
import { buildTestGraph } from "./helpers/graph.js";
import { StreamingChatModel, toolCall } from "./helpers/models.js";

// Fase 12 (T6, CA4): el registro de operación. El del proceso escribe en una carpeta temporal (COPILOT_LOG_DIR, antes de
// importar nada); los demás tests no dejan archivos.
const DIR = vi.hoisted(() => {
  const dir = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/copiloto-log-test-${process.pid}`;
  process.env.COPILOT_LOG_DIR = dir;
  return dir;
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const lines = (dir = DIR) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".log"))
        .flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean))
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

describe("el registro", () => {
  it("una línea JSON por evento, en el archivo del día de Argentina; la consola solo ve avisos y errores", () => {
    const dir = `${DIR}-unidad`;
    const out = { warn: vi.fn(), error: vi.fn() };
    const logger = createLogger({ dir, clock: () => new Date("2026-11-07T02:30:00Z"), console: out }); // 23:30 del 6 en Argentina
    logger.info("turno", { threadId: "h", costUsd: 0.001 });
    logger.warn("reintento", "[reintento] stock 2 de 3", { attempt: 2 });
    logger.error("web", "falló", { error: new Error("connect ECONNREFUSED postgresql://copilot_reader:secreto@localhost:5432/postgres") });
    logger.record("error", "solo-archivo");
    expect(readdirSync(dir)).toEqual(["copiloto-2026-11-06.log"]);
    const [info, warn, error, record] = lines(dir);
    expect(info).toMatchObject({ level: "info", event: "turno", threadId: "h", costUsd: 0.001, ts: "2026-11-07T02:30:00.000Z" });
    expect(warn).toMatchObject({ level: "warn", event: "reintento", text: "[reintento] stock 2 de 3", attempt: 2 });
    expect(error).toMatchObject({ level: "error", error: { name: "Error", message: "connect ECONNREFUSED postgresql://copilot_reader:***@localhost:5432/postgres" } });
    expect(record).toMatchObject({ level: "error", event: "solo-archivo" });
    expect(out.warn).toHaveBeenCalledWith("[reintento] stock 2 de 3");
    expect(out.error).toHaveBeenCalledTimes(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("tapa las contraseñas de las URL de conexión, también en el código del error", () => {
    expect(redact("postgresql://postgres.tenant:mi-clave@localhost:5432/postgres y nada más")).toBe("postgresql://postgres.tenant:***@localhost:5432/postgres y nada más");
    expect(errorData(Object.assign(new Error("x"), { code: "57014" }))).toEqual({ name: "Error", code: "57014", message: "x" });
  });

  it("borra los archivos de más de N días y deja los demás", () => {
    const dir = `${DIR}-viejos`;
    mkdirSync(dir, { recursive: true });
    for (const f of ["copiloto-2026-10-01.log", "copiloto-2026-10-25.log", "copiloto-2026-11-06.log", "otro.txt"]) writeFileSync(join(dir, f), "{}\n");
    // El del 25 de octubre tiene 13 días: se queda. El del 1, no.
    expect(pruneLogs(dir, 14, new Date("2026-11-07T12:00:00Z"))).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["copiloto-2026-10-25.log", "copiloto-2026-11-06.log", "otro.txt"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("lo que deja un turno (CA4)", () => {
  async function all(events: AsyncIterable<UiEvent>) {
    const out: UiEvent[] = [];
    for await (const e of events) out.push(e);
    return out;
  }
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rmSync(DIR, { recursive: true, force: true });
  });

  it("un turno, un reintento, un corte por tiempo y un error, sin el texto de los mensajes", async () => {
    let calls = 0;
    const flaky = tool(
      safeTool("getStockLevels", async () => {
        if (++calls <= 1) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        return { items: [] };
      }, { sleep: async () => {} }),
      { name: "getStockLevels", description: "stock", schema: z.object({}) },
    );
    const ok = buildTestGraph({ model: new StreamingChatModel([toolCall("c1", "getStockLevels"), new AIMessage("Quedan 31 unidades de cera.")]), tools: [flaky], intent: "query", checkpointer: new MemorySaver() });
    await all(streamRunTurn({ graph: ok }, "h1", "¿cuánta cera mate queda?"));

    const slow = buildTestGraph({ model: new StreamingChatModel([new AIMessage("Una respuesta que tarda demasiado en escribirse entera.")], { delayMs: 40 }), tools: [], intent: "chat", checkpointer: new MemorySaver() });
    await all(streamRunTurn({ graph: slow, limits: { turnTimeoutMs: 100 } }, "h2", "contame")).catch(() => undefined);

    const broken = buildTestGraph({ model: { async invoke() { throw new Error("se rompió"); } } as never, tools: [], intent: "chat", checkpointer: new MemorySaver() });
    await all(streamRunTurn({ graph: broken }, "h3", "hola")).catch(() => undefined);

    const all3 = lines();
    const events = all3.map((l) => [l.event, l.threadId ?? null, l.status ?? null]);
    expect(events).toContainEqual(["reintento", null, null]);
    expect(events).toContainEqual(["turno", "h1", "ok"]);
    expect(events, "a medias: se puede continuar").toContainEqual(["turno-cortado-por-tiempo", "h2", "pending"]);
    expect(events).toContainEqual(["turno-fallo", "h3", "error"]);
    const h1 = all3.find((l) => l.event === "turno" && l.threadId === "h1")!;
    expect(h1).toMatchObject({ kind: "new", costUsd: expect.any(Number), durationMs: expect.any(Number) });
    const text = JSON.stringify(all3);
    expect(text, "ni el mensaje de la persona ni la respuesta").not.toMatch(/cera mate|Quedan 31|contame/);
  });
});
