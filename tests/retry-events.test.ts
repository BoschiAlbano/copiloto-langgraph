import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import { runSection } from "../src/graph/report/sections.js";
import { streamRunTurn } from "../src/graph/run-turn.js";
import { safeTool } from "../src/tools/safe.js";
import type { UiEvent } from "../src/web/events.js";
import { applyEvent, fromThreadView, startMessage } from "../src/web/turn-view.js";
import { buildTestGraph } from "./helpers/graph.js";
import { StreamingChatModel, toolCall } from "./helpers/models.js";

// Fase 10 (T3, R2): los reintentos se ven mientras ocurren, por el modo `custom` de LangGraph.

const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
const instant = { sleep: async () => {} };
async function all(events: AsyncIterable<UiEvent>) {
  const out: UiEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function flakyStock(failures: number | "always") {
  let calls = 0;
  const t = tool(
    safeTool("getStockLevels", async () => {
      calls++;
      if (failures === "always" || calls <= failures) throw refused();
      return { items: [{ name: "Cera mate", stock: 31 }] };
    }, instant),
    { name: "getStockLevels", description: "stock", schema: z.object({}) },
  );
  return { tool: t, calls: () => calls };
}

describe("eventos retry en vivo", () => {
  it("una herramienta dentro del subgrafo avisa cada reintento, entre tool_start y tool_end", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stock = flakyStock(2);
    const graph = buildTestGraph({
      model: new StreamingChatModel([toolCall("c1", "getStockLevels"), new AIMessage("Quedan 31.")]),
      tools: [stock.tool],
      checkpointer: new MemorySaver(),
    });
    const events = await all(streamRunTurn({ graph }, "hilo-retry", "¿stock?"));
    const kinds = events.filter((e) => ["tool_start", "retry", "tool_end"].includes(e.type));
    expect(kinds).toEqual([
      expect.objectContaining({ type: "tool_start", name: "getStockLevels" }),
      { type: "retry", agent: "query_graph", target: "getStockLevels", attempt: 2, attempts: 3 },
      { type: "retry", agent: "query_graph", target: "getStockLevels", attempt: 3, attempts: 3 },
      expect.objectContaining({ type: "tool_end", ok: true }),
    ]);
    const done = events.at(-1);
    expect(done?.type === "done" && done.result.summary.failedTools).toEqual([]);
  });

  it("si falla siempre: dos reintentos, la herramienta termina con error y el resumen lo marca", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stock = flakyStock("always");
    const graph = buildTestGraph({
      model: new StreamingChatModel([toolCall("c1", "getStockLevels"), new AIMessage("No pude consultar el stock.")]),
      tools: [stock.tool],
      checkpointer: new MemorySaver(),
    });
    const events = await all(streamRunTurn({ graph }, "hilo-retry-2", "¿stock?"));
    expect(events.filter((e) => e.type === "retry")).toHaveLength(2);
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ ok: false });
    const done = events.at(-1);
    expect(done?.type === "done" && done.result.summary.failedTools).toEqual(["getStockLevels"]);
    expect(stock.calls()).toBe(3);
  });

  it("una sección del reporte también avisa sus reintentos", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const db = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        if (++calls <= 2) throw refused();
        return strings.join("").includes("COUNT(*)") ? [{ total: 1, lowCount: 0 }] : [];
      },
    } as unknown as Db;
    const graph = buildTestGraph({
      model: new StreamingChatModel([new AIMessage("• Bien.")]),
      tools: [],
      intent: "report",
      reportPlan: { async invoke() { return { parsed: { reason: "semana", kind: "this_week" } }; } },
      reportSections: (section, reportId, range) =>
        section === "stock" ? runSection(section, reportId, range, db) : Promise.resolve({ reportId, section, status: "error", error: "no probada" }),
      now: () => new Date("2026-10-28T15:00:00Z"),
      checkpointer: new MemorySaver(),
    });
    const events = await all(streamRunTurn({ graph }, "hilo-retry-3", "resumen de la semana"));
    expect(events.filter((e) => e.type === "retry")).toEqual([expect.objectContaining({ target: "section:stock", attempt: 2, agent: "report_graph" })]);
    expect(events.find((e) => e.type === "report_section" && e.section === "stock")).toMatchObject({ status: "ok" });
  });
});

describe("el reintento en la página", () => {
  const view = { threadId: "h", exists: false, status: "ready" as const, running: false, next: [], messages: [] };

  it("se marca en la línea de su herramienta; una sección tiene su propia línea, que se actualiza", () => {
    let state = startMessage(fromThreadView(view), "x");
    state = [
      { type: "tool_start", id: "c1", agent: "query_graph", name: "getStockLevels", args: {} },
      { type: "retry", agent: "query_graph", target: "getStockLevels", attempt: 2, attempts: 3 },
      { type: "retry", target: "section:stock", attempt: 2, attempts: 3 },
      { type: "retry", target: "section:stock", attempt: 3, attempts: 3 },
    ].reduce((s, e) => applyEvent(s, e as UiEvent), state);
    const turn = state.items.at(-1);
    if (turn?.kind !== "turn") throw new Error("sin turno");
    expect(turn.parts).toEqual([
      { type: "tool", id: "c1", agent: "query_graph", name: "getStockLevels", args: {}, status: "running", retry: { attempt: 2, attempts: 3 } },
      { type: "retry", target: "section:stock", attempt: 3, attempts: 3 },
    ]);
  });
});
