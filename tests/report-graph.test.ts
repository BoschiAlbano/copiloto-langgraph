import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import type { SectionRunner } from "../src/graph/nodes/report.js";
import type { ReportPart, Section } from "../src/graph/report/state.js";
import { buildTestGraph } from "./helpers/graph.js";
import { echoModel, scriptedModel } from "./helpers/models.js";
import { getHistory, getSubgraphHistory } from "../src/graph/threads.js";
import { runTurn } from "../src/graph/run-turn.js";

// Reporte completo (planificador → tres secciones en paralelo → consolidación) con modelos y secciones falsas.
// Las cifras contra la base real se prueban en tests/report-db.test.ts.

const DATA: Record<Section, unknown> = {
  sales: { salesCount: 38, totalRevenue: 312_400, averageTicket: 8_221, byPaymentMethod: [{ method: "cash", count: 38, total: 312_400 }], byItemType: { products: { units: 31, revenue: 112_400 }, services: { units: 25, revenue: 200_000 } } },
  appointments: { total: 120, activeCount: 112, countByStatus: { scheduled: 112, cancelled: 8 } },
  stock: { total: 15, lowCount: 1, low: [{ name: "Pomada clásica", sku: "POM-001", stock: 3, minStock: 5 }] },
};
const NOW = new Date("2026-10-28T15:00:00Z");
const THREAD = { configurable: { thread_id: "hilo-reporte" } };

interface Run {
  section: Section;
  start: number;
  end: number;
}

/** Secciones falsas que demoran `delayMs` y registran cuándo empezaron y terminaron. */
function timedSections(delayMs: number, fail: Section[] = []) {
  const runs: Run[] = [];
  const runner: SectionRunner = async (section, reportId) => {
    const start = performance.now();
    await new Promise((r) => setTimeout(r, delayMs));
    runs.push({ section, start, end: performance.now() });
    if (fail.includes(section)) return { reportId, section, status: "error", error: "problema del sistema (código P1000)" } satisfies ReportPart;
    return { reportId, section, status: "ok", data: DATA[section] } satisfies ReportPart;
  };
  return { runner, runs };
}

const planner = (parsed: unknown = { reason: "pide la semana", kind: "this_week" }) => {
  const calls = { n: 0 };
  return { calls, model: { async invoke() { calls.n++; return { parsed }; } } };
};

function setup(options: { delayMs?: number; fail?: Section[]; reading?: string | Error; checkpointer?: MemorySaver } = {}) {
  const sections = timedSections(options.delayMs ?? 0, options.fail);
  const plan = planner();
  const reading = options.reading ?? "• Casi todo se cobró en efectivo.";
  const readingModel = scriptedModel(() => {
    if (reading instanceof Error) throw reading;
    return new AIMessage(reading);
  });
  const graph = buildTestGraph({
    model: readingModel.model,
    tools: [],
    intent: "report",
    reportPlan: plan.model,
    reportSections: sections.runner,
    now: () => NOW,
    checkpointer: options.checkpointer,
  });
  return { graph, sections, plan, readingModel };
}

const ask = (text = "Armame el resumen de la semana.") => ({ messages: [new HumanMessage(text)] });

describe("CA1: las tres secciones corren a la vez", () => {
  it("el reporte tarda lo de UNA sección, no la suma, y los intervalos de ejecución se superponen", async () => {
    const t = setup({ delayMs: 250 });
    const start = performance.now();
    await t.graph.invoke(ask());
    const elapsed = performance.now() - start;

    expect(t.sections.runs.map((r) => r.section).sort()).toEqual(["appointments", "sales", "stock"]);
    // Tres secciones de 250 ms en serie serían ≥ 750 ms. En paralelo, cerca de 250 ms (con margen para máquinas lentas).
    expect(elapsed).toBeLessThan(600);

    // Cada sección empezó antes de que terminara cualquiera de las otras: se solapan.
    for (const a of t.sections.runs) {
      for (const b of t.sections.runs) expect(a.start, `${a.section} vs ${b.section}`).toBeLessThan(b.end);
    }
  });

  it("la historia de checkpoints muestra las tres secciones en un único paso, y compose_report en el siguiente", async () => {
    const saver = new MemorySaver();
    const t = setup({ checkpointer: saver });
    await runTurn({ graph: t.graph }, "hilo-reporte", "Armame el resumen de la semana.");

    // Fase 7: en la historia del grafo principal, el subgrafo de reportes es UN paso…
    const history = (await getHistory(t.graph as never, "hilo-reporte")).reverse(); // del más viejo al más nuevo
    expect(history.map((c) => c.ranNodes.join("+"))).toEqual(["", "__start__", "router", "supervisor", "report_graph", "supervisor"]);
    expect(history.at(-1)!.next).toEqual([]);

    // …y sus pasos internos quedan en sus propios checkpoints, donde se ve el paralelismo.
    const [run] = await getSubgraphHistory(t.graph as never, saver, "hilo-reporte");
    expect(run!.node).toBe("report_graph");
    const ran = [...run!.checkpoints].reverse().map((c) => c.ranNodes.slice().sort().join("+"));
    expect(ran).toEqual([
      "", // entrada del subgrafo
      "__start__",
      "plan_report",
      "report_appointments+report_sales+report_stock", // ← las tres en el mismo paso
      "compose_report",
    ]);
  });

  it("runTurn informa el período y el estado de cada sección; un turno que no es un reporte no lo informa", async () => {
    const saver = new MemorySaver();
    const t = setup({ fail: ["stock"], checkpointer: saver });
    const turn = await runTurn({ graph: t.graph }, "hilo-reporte", "Armame el resumen de la semana.");
    expect(turn.route.intent).toBe("report");
    expect(turn.report).toEqual({ label: "semana del 26/10 al 01/11", sections: { sales: "ok", appointments: "ok", stock: "error" } });
    expect(turn.summary.toolCalls).toEqual([]);

    // Un turno de charla en el mismo hilo ya no trae reporte, aunque el estado todavía lo guarde.
    const chatGraph = buildTestGraph({ model: echoModel().model, tools: [], intent: "chat", checkpointer: saver });
    const chat = await runTurn({ graph: chatGraph }, "hilo-reporte", "gracias");
    expect(chat.report).toBeUndefined();
  });

  it("compose_report corre exactamente una vez, después de las tres", async () => {
    const t = setup({ delayMs: 20 });
    const order: string[] = [];
    // Con `subgraphs: true` el stream trae también los pasos de adentro del subgrafo de reportes.
    const stream = await t.graph.stream(ask(), { streamMode: ["updates"], subgraphs: true });
    for await (const [namespace, mode, chunk] of stream as AsyncIterable<[string[], string, object]>) {
      if (mode === "updates" && namespace.length) order.push(...Object.keys(chunk));
    }
    expect(order.filter((n) => n === "compose_report")).toHaveLength(1);
    expect(order.at(-1)).toBe("compose_report");
    expect(order.indexOf("compose_report")).toBeGreaterThan(Math.max(...["report_sales", "report_appointments", "report_stock"].map((n) => order.indexOf(n))));
    expect(t.readingModel.calls).toHaveLength(1); // una sola «Lectura»
    expect(t.plan.calls.n).toBe(1); // un solo planificador
  });
});

describe("el reporte final", () => {
  it("incluye las tres secciones y la «Lectura»", async () => {
    const t = setup();
    const result = await t.graph.invoke(ask());
    const text = result.messages.at(-1)!.text;
    for (const title of ["Reporte · semana del 26/10 al 01/11", "\nVentas\n", "\nTurnos\n", "\nStock\n", "\nLectura\n"]) expect(text).toContain(title);
    expect(text).toContain("38 ventas por $ 312.400");
    expect(text).toContain("120 turnos en el período, 112 activos");
    expect(text).toContain("Pomada clásica (POM-001): 3 de 5");
    // Es un mensaje de IA común: la conversación sigue siendo válida para el modelo.
    expect(AIMessage.isInstance(result.messages.at(-1))).toBe(true);
  });

  it("las secciones reciben el período que decidió el planificador", async () => {
    const seen: unknown[] = [];
    const graph = buildTestGraph({
      model: echoModel().model,
      tools: [],
      intent: "report",
      reportPlan: planner({ reason: "x", kind: "last_month" }).model,
      reportSections: async (section, reportId, range) => {
        seen.push(range);
        return { reportId, section, status: "ok", data: DATA[section] };
      },
      now: () => NOW,
    });
    await graph.invoke(ask("cómo estuvo el mes pasado"));
    expect(seen).toHaveLength(3);
    for (const range of seen) expect(range).toEqual({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  });
});

describe("CA3: falla parcial", () => {
  for (const failing of ["sales", "appointments", "stock"] as const) {
    it(`si falla ${failing}, el reporte sale con las otras dos y dice cuál falta`, async () => {
      const t = setup({ fail: [failing] });
      const result = await t.graph.invoke(ask());
      const text = result.messages.at(-1)!.text;
      expect(text.match(/No disponible/g)).toHaveLength(1);
      expect(text).toContain("problema del sistema (código P1000)");
      const present = { sales: "38 ventas", appointments: "120 turnos", stock: "Pomada clásica" } as const;
      for (const [section, marker] of Object.entries(present)) expect(text.includes(marker), `${failing} / ${section}`).toBe(section !== failing);
    });
  }

  it("si fallan las tres, el turno no falla y el reporte lo dice", async () => {
    const t = setup({ fail: ["sales", "appointments", "stock"] });
    const result = await t.graph.invoke(ask());
    expect(result.messages.at(-1)!.text).toContain("No se pudo armar ninguna de las tres secciones.");
    expect(t.readingModel.calls).toHaveLength(0);
  });

  it("si falla la «Lectura», el reporte sale completo con un aviso", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup({ reading: new Error("529 overloaded") });
    const result = await t.graph.invoke(ask());
    const text = result.messages.at(-1)!.text;
    expect(text).toContain("38 ventas por $ 312.400");
    expect(text).toContain("No pude agregar la «Lectura»");
    vi.restoreAllMocks();
  });

  it("CA7: una «Lectura» que inventa una cifra se descarta", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup({ reading: "• Las ventas crecieron 40 % esta semana." });
    const text = (await t.graph.invoke(ask())).messages.at(-1)!.text;
    expect(text).not.toContain("40 %");
    expect(text).toContain("Descarté la «Lectura»");
    expect(text).toContain("38 ventas por $ 312.400"); // las cifras del código siguen intactas
    vi.restoreAllMocks();
  });
});

describe("CA9: el reporte en un hilo", () => {
  it("se guarda como un mensaje normal y un segundo reporte en el mismo hilo no mezcla partes con el primero", async () => {
    const saver = new MemorySaver();
    const t = setup({ checkpointer: saver });
    await runTurn({ graph: t.graph }, "hilo-reporte", "Armame el resumen de la semana.");
    const first = await t.graph.getState(THREAD);
    const firstId = first.values.report!.id;
    // Fase 7 (CA4): las partes son privadas del subgrafo de reportes; el grafo principal no las tiene.
    expect(first.values).not.toHaveProperty("reportParts");

    await runTurn({ graph: t.graph }, "hilo-reporte", "Y ahora el del mes.");
    const second = await t.graph.getState(THREAD);
    expect(second.values.report!.id).not.toBe(firstId);
    expect(second.values.messages.filter((m: { type: string }) => m.type === "ai")).toHaveLength(2);

    // Cada pedido es una corrida nueva del subgrafo, con su propio estado: el segundo tiene sus 3 partes, no 6.
    const runs = await getSubgraphHistory(t.graph as never, saver, "hilo-reporte");
    expect(runs.map((r) => r.node)).toEqual(["report_graph", "report_graph"]);
    const parts = async (namespace: string) =>
      (await t.graph.getState({ configurable: { thread_id: "hilo-reporte", checkpoint_ns: namespace } })).values.reportParts as ReportPart[];
    const [a, b] = [await parts(runs[0]!.namespace), await parts(runs[1]!.namespace)];
    expect(a.map((p) => p.reportId)).toEqual([firstId, firstId, firstId]);
    expect(b).toHaveLength(3);
    expect(new Set(b.map((p) => p.reportId))).toEqual(new Set([second.values.report!.id]));
  });
});
