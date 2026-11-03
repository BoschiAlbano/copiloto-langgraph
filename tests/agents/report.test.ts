import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { buildReportGraph } from "../../src/agents/report.js";
import type { SectionRunner } from "../../src/graph/nodes/report.js";
import type { Plan } from "../../src/graph/plan.js";
import type { ReportPart, Section } from "../../src/graph/report/state.js";
import { getHistory } from "../../src/graph/threads.js";
import { scriptedModel } from "../helpers/models.js";

// CA3: el subgrafo de reportes se prueba solo. El paralelismo de la fase 6 (CA1) se comprueba acá, sin el supervisor.

const DATA: Record<Section, unknown> = {
  sales: { salesCount: 38, totalRevenue: 312_400, averageTicket: 8_221, byPaymentMethod: [{ method: "cash", count: 38, total: 312_400 }], byItemType: { products: { units: 31, revenue: 112_400 }, services: { units: 25, revenue: 200_000 } } },
  appointments: { total: 120, activeCount: 112, countByStatus: { scheduled: 112, cancelled: 8 } },
  stock: { total: 15, lowCount: 1, low: [{ name: "Pomada clásica", sku: "POM-001", stock: 3, minStock: 5 }] },
};
const NOW = new Date("2026-10-28T15:00:00Z");

function setup(options: { delayMs?: number; fail?: Section[]; checkpointer?: MemorySaver } = {}) {
  const runs: { section: Section; start: number; end: number }[] = [];
  const sections: SectionRunner = async (section, reportId) => {
    const start = performance.now();
    await new Promise((r) => setTimeout(r, options.delayMs ?? 0));
    runs.push({ section, start, end: performance.now() });
    if (options.fail?.includes(section)) return { reportId, section, status: "error", error: "problema del sistema (código P1000)" } satisfies ReportPart;
    return { reportId, section, status: "ok", data: DATA[section] } satisfies ReportPart;
  };
  const planCalls: BaseMessage[][] = [];
  const plan = { async invoke(messages: BaseMessage[]) { planCalls.push(messages); return { parsed: { reason: "semana", kind: "this_week" } }; } };
  const reading = scriptedModel(() => new AIMessage("• Casi todo se cobró en efectivo."));
  const graph = buildReportGraph({ plan, reading: reading.model, sections, now: () => NOW, warn: () => {}, checkpointer: options.checkpointer });
  return { graph, runs, planCalls, reading };
}

const ask = (text = "Armame el resumen de la semana.") => ({ messages: [new HumanMessage(text)] });

describe("subgrafo de reportes (CA3)", () => {
  it("las tres secciones corren a la vez: tarda lo de una, no la suma", async () => {
    const t = setup({ delayMs: 250 });
    const start = performance.now();
    await t.graph.invoke(ask());
    expect(performance.now() - start).toBeLessThan(600);
    for (const a of t.runs) for (const b of t.runs) expect(a.start, `${a.section} vs ${b.section}`).toBeLessThan(b.end);
  });

  it("su historia de checkpoints muestra las tres secciones en un único paso y compose_report en el siguiente", async () => {
    const t = setup({ checkpointer: new MemorySaver() });
    await t.graph.invoke(ask(), { configurable: { thread_id: "solo-reportes" } });
    const history = (await getHistory(t.graph as never, "solo-reportes")).reverse();
    expect(history.map((c) => c.ranNodes.slice().sort().join("+"))).toEqual([
      "",
      "__start__",
      "plan_report",
      "report_appointments+report_sales+report_stock",
      "compose_report",
    ]);
  });

  it("devuelve el reporte con el estado de cada sección; las partes quedan en su propio estado", async () => {
    const t = setup({ fail: ["stock"] });
    const result = await t.graph.invoke(ask());
    expect(result.report).toMatchObject({ label: "semana del 26/10 al 01/11", sections: { sales: "ok", appointments: "ok", stock: "error" } });
    expect(result.reportParts).toHaveLength(3);
    expect(result.messages.at(-1)!.text).toContain("No disponible");
    expect(t.reading.calls).toHaveLength(1);
  });

  it("en un pedido de varias partes, el planificador recibe la parte que es el reporte", async () => {
    const t = setup();
    const plan: Plan = {
      tasks: [
        { id: "1", intent: "action", request: "cancelá el turno", status: "done", startedAt: 1 },
        { id: "2", intent: "report", request: "resumen de la semana pasada", status: "running", startedAt: 2 },
      ],
    };
    await t.graph.invoke({ messages: [new HumanMessage("cancelá el turno y armame el resumen"), new AIMessage("Cancelado.")], plan });
    expect(t.planCalls[0]![1]!.text).toContain("La parte del pedido que es el reporte: «resumen de la semana pasada».");
  });

  it("con una sola tarea, el planificador recibe lo mismo que en la fase 6", async () => {
    const t = setup();
    await t.graph.invoke(ask());
    expect(t.planCalls[0]![1]!.text).not.toContain("La parte del pedido");
  });
});
