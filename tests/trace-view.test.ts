import { describe, expect, it } from "vitest";
import type { TraceSpan } from "../src/observability/trace-recorder.js";
import { formatDuration, prettyJson, timelineRows } from "../src/web/trace-view.js";

// Fase 11 (T4, R5): la línea de tiempo de una traza, sin navegador.

const span = (id: string, parentId: string | undefined, start: number, duration: number, over: Partial<TraceSpan> = {}): TraceSpan => ({
  id,
  ...(parentId && { parentId }),
  kind: "node",
  name: id,
  start,
  duration,
  status: "ok",
  ...over,
});

describe("timelineRows", () => {
  it("cada paso debajo de su padre, por orden de inicio, con su barra en % del turno", () => {
    const rows = timelineRows({
      durationMs: 1000,
      spans: [
        span("turno", undefined, 0, 1000, { kind: "turn" }),
        span("query_graph", "turno", 300, 600),
        span("router", "turno", 50, 200),
        span("tools", "query_graph", 500, 100),
        span("llm", "query_graph", 310, 150, { kind: "llm", inputTokens: 4400, outputTokens: 60 }),
        span("getStockLevels", "tools", 510, 80, { kind: "tool", retries: 2 }),
      ],
    });
    expect(rows.map((r) => [r.span.id, r.depth])).toEqual([
      ["turno", 0],
      ["router", 1],
      ["query_graph", 1],
      ["llm", 2],
      ["tools", 2],
      ["getStockLevels", 3],
    ]);
    const byId = Object.fromEntries(rows.map((r) => [r.span.id, r]));
    expect(byId.router).toMatchObject({ offsetPct: 5, widthPct: 20 });
    expect(byId.llm!.detail).toBe("4400 → 60 tokens");
    expect(byId.getStockLevels!.detail).toBe("2 reintentos");
  });

  it("un paso muy corto se ve igual, y ninguna barra se pasa del final", () => {
    const rows = timelineRows({ durationMs: 10_000, spans: [span("turno", undefined, 0, 10_000, { kind: "turn" }), span("rápido", "turno", 9_999, 1)] });
    const fast = rows.find((r) => r.span.id === "rápido")!;
    expect(fast.widthPct).toBeGreaterThan(0);
    expect(fast.offsetPct + fast.widthPct).toBeLessThanOrEqual(100);
  });

  it("un paso sin padre conocido cuelga de la raíz; una traza vacía no tiene filas", () => {
    const rows = timelineRows({ durationMs: 100, spans: [span("turno", undefined, 0, 100, { kind: "turn" }), span("huérfano", "no-existe", 10, 10)] });
    expect(rows.map((r) => [r.span.id, r.depth])).toEqual([
      ["turno", 0],
      ["huérfano", 1],
    ]);
    expect(timelineRows({ durationMs: 0, spans: [] })).toEqual([]);
  });
});

describe("formato", () => {
  it("duraciones", () => {
    expect(formatDuration(840)).toBe("840 ms");
    expect(formatDuration(3140)).toBe("3,1 s");
    expect(formatDuration(72_000)).toBe("1 min 12 s");
  });

  it("un JSON se muestra con sangría; un texto, tal cual", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("no es json")).toBe("no es json");
    expect(prettyJson({ sku: "CER-001" })).toBe('{\n  "sku": "CER-001"\n}');
  });
});
