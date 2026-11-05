import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resumeTurn, streamContinueTurn, streamRunTurn, type TurnAgent } from "../src/graph/run-turn.js";
import { getStatus } from "../src/graph/threads.js";
import { streamForkTurn, streamReplayTurn } from "../src/graph/time-travel.js";
import { MemoryTraceStore } from "../src/observability/store.js";
import { safeTool } from "../src/tools/safe.js";
import type { UiEvent } from "../src/web/events.js";
import { fakeActions } from "./helpers/actions.js";
import { buildTestGraph } from "./helpers/graph.js";
import { scriptedModel, StreamingChatModel, toolCall } from "./helpers/models.js";

// Fase 11 (T3: CA1 y CA2): cada turno deja su traza por el camino de siempre (`streamInvoke`), y guardarla nunca
// rompe ni frena el turno.

async function all(events: AsyncIterable<UiEvent>) {
  const out: UiEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
const done = (events: UiEvent[]) => {
  const last = events.at(-1);
  if (last?.type !== "done") throw new Error(`el turno no terminó: ${JSON.stringify(last)}`);
  return last.result;
};

function echo() {
  const { model } = scriptedModel((n, msgs) => new AIMessage(`eco ${n + 1}: ${msgs.findLast((m) => m.type === "human")?.text}`));
  return buildTestGraph({ model, tools: [], intent: "chat", checkpointer: new MemorySaver() });
}

describe("cada turno deja su traza (CA1)", () => {
  it("un mensaje nuevo: tipo, mensaje, ruta, estado y el id en el resultado del turno", async () => {
    const traces = new MemoryTraceStore();
    const agent: TurnAgent = { graph: echo(), traces };
    const result = done(await all(streamRunTurn(agent, "h", "hola")));
    expect(traces.traces).toHaveLength(1);
    const [trace] = traces.traces;
    expect(trace).toMatchObject({ id: result.traceId, threadId: "h", kind: "new", input: "hola", status: "ok", route: ["chat"] });
    expect(trace!.spans.some((s) => s.name === "chat")).toBe(true);
  });

  it("sin dónde guardarlas, no hay trazas ni id (los tests de las fases anteriores siguen igual)", async () => {
    const result = done(await all(streamRunTurn({ graph: echo() }, "h", "hola")));
    expect(result.traceId).toBeUndefined();
  });

  it("editar y reintentar dejan su traza, cada una con su tipo y su mensaje", async () => {
    const traces = new MemoryTraceStore();
    const agent: TurnAgent = { graph: echo(), traces };
    const first = (await all(streamRunTurn(agent, "h", "hola")))[0];
    if (first?.type !== "turn") throw new Error("sin turn");
    await all(streamForkTurn(agent, "h", first.humanMessageId, "buenas"));
    const edited = (await getStatus(agent.graph, "h")).messages[0]!.id!;
    await all(streamReplayTurn(agent, "h", edited));
    expect(traces.traces.map((t) => [t.kind, t.input, t.status])).toEqual([
      ["new", "hola", "ok"],
      ["edit", "buenas", "ok"],
      ["retry", "buenas", "ok"],
    ]);
  });

  it("una acción: la pausa queda «awaiting» y decidir es un turno «resume» con la decisión", async () => {
    const traces = new MemoryTraceStore();
    const model = scriptedModel([toolCall("a1", "adjustStock", { sku: "CER-001", delta: 5, reason: "pedido" }), new AIMessage("Listo.")]);
    const graph = buildTestGraph({ model: model.model, tools: [], intent: "action", actions: fakeActions().runner, checkpointer: new MemorySaver() });
    const agent: TurnAgent = { graph, traces };
    await all(streamRunTurn(agent, "h", "sumá 5"));
    await resumeTurn(agent, "h", { decision: "reject", comment: "mejor no" });
    expect(traces.traces.map((t) => [t.kind, t.input, t.status, t.route])).toEqual([
      ["new", "sumá 5", "awaiting", ["action"]],
      ["resume", "reject: mejor no", "ok", ["action"]],
    ]);
  });

  it("los reintentos de una herramienta se cuentan en su paso", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const flaky = tool(
      safeTool("getStockLevels", async () => {
        if (++calls <= 2) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        return { items: [] };
      }, { sleep: async () => {} }),
      { name: "getStockLevels", description: "stock", schema: z.object({}) },
    );
    const traces = new MemoryTraceStore();
    const graph = buildTestGraph({ model: new StreamingChatModel([toolCall("c1", "getStockLevels"), new AIMessage("Listo.")]), tools: [flaky], intent: "query", checkpointer: new MemorySaver() });
    await all(streamRunTurn({ graph, traces }, "h", "¿stock?"));
    const [trace] = traces.traces;
    expect(trace!.spans.find((s) => s.name === "getStockLevels")).toMatchObject({ retries: 2, status: "ok" });
    expect(trace!.retries).toBe(2);
    vi.restoreAllMocks();
  });

  it("un turno que falla deja una traza con el error; continuarlo deja otra", async () => {
    const traces = new MemoryTraceStore();
    let fail = true;
    const model = { async invoke() { if (fail) throw new Error("connect ECONNREFUSED 127.0.0.1:5432"); return new AIMessage("ahora sí"); } };
    const graph = buildTestGraph({ model: model as never, tools: [], intent: "chat", checkpointer: new MemorySaver() });
    await expect(all(streamRunTurn({ graph, traces }, "h", "hola"))).rejects.toThrow(/ECONNREFUSED/);
    fail = false;
    await all(streamContinueTurn({ graph, traces }, "h"));
    expect(traces.traces.map((t) => [t.kind, t.status])).toEqual([
      ["new", "error"],
      ["continue", "ok"],
    ]);
    expect(traces.traces[0]!.error).toMatch(/ECONNREFUSED/);
  });

  it("un turno cortado (se cerró la página) queda «pending»", async () => {
    const traces = new MemoryTraceStore();
    const LONG = "Una respuesta larga, que se escribe de a poco, para cortarla a la mitad sin que termine.";
    const graph = buildTestGraph({ model: new StreamingChatModel([new AIMessage(LONG)], { delayMs: 10 }), tools: [], intent: "chat", checkpointer: new MemorySaver() });
    const cut = new AbortController();
    await expect(
      (async () => {
        for await (const e of streamRunTurn({ graph, traces }, "h", "contame", cut.signal)) if (e.type === "token") cut.abort();
      })(),
    ).rejects.toThrow();
    expect(traces.traces.map((t) => t.status)).toEqual(["pending"]);
  });
});

describe("guardar la traza no rompe el turno (CA2)", () => {
  it("si guardar falla (asincrónico o no), el turno termina igual y queda un aviso", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejecting = { save: async () => { throw new Error("la base no responde"); } };
    const throwing = { save: () => { throw new Error("se rompió"); } };
    for (const traces of [rejecting, throwing]) {
      const result = done(await all(streamRunTurn({ graph: echo(), traces: traces as never }, "h", "hola")));
      expect(result.reply).toBe("eco 1: hola");
    }
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    const warnings = warn.mock.calls.map((c) => String(c[0])).join(" | ");
    expect(warnings).toMatch(/\[trazas\] No se pudo guardar la traza .*: se rompió/);
    expect(warnings).toMatch(/\[trazas\] No se pudo guardar la traza .*: la base no responde/);
    vi.restoreAllMocks();
  });

  it("el turno no espera a que termine de guardarse", async () => {
    let release!: () => void;
    const slow = { save: () => new Promise<void>((r) => (release = r)) };
    const result = done(await all(streamRunTurn({ graph: echo(), traces: slow }, "h", "hola")));
    expect(result.reply).toBe("eco 1: hola"); // llegó aunque la escritura sigue pendiente
    release();
  });
});
