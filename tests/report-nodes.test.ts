import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { makeComposeReportNode, makePlanReportNode, makeSectionNode, fanOutReport, SECTION_NODES, READING_DISCARDED_NOTICE, READING_FAILED_NOTICE } from "../src/graph/nodes/report.js";
import { PLAN_FALLBACK_NOTICE } from "../src/graph/report/plan.js";
import type { ReportPart } from "../src/graph/report/state.js";
import { makeState } from "../src/graph/state.js";
import type { AgentModel } from "../src/graph/nodes/agent.js";
import { numbersIn, unknownNumbers } from "../src/graph/report/numbers.js";

const NOW = new Date("2026-10-28T15:00:00Z");
const ask = (text = "armame el resumen") => makeState([new HumanMessage(text)]);

function fakePlanner(parsed: unknown) {
  const calls: unknown[][] = [];
  return { calls, model: { async invoke(messages: unknown[]) { calls.push(messages); return { parsed }; } } };
}

describe("plan_report", () => {
  const node = (parsed: unknown, warn = vi.fn()) => ({ run: makePlanReportNode(fakePlanner(parsed).model as never, { now: () => NOW, newId: () => "id-fijo", warn }), warn });

  it("convierte la forma simbólica en fechas con el reloj, sin que el modelo haga cuentas", async () => {
    const { report } = await node({ reason: "pide la semana", kind: "this_week" }).run(ask());
    expect(report).toEqual({ id: "id-fijo", dateFrom: "2026-10-26", dateTo: "2026-11-01", label: "semana del 26/10 al 01/11" });
    expect(report.notice).toBeUndefined();
  });

  it("acepta cada forma", async () => {
    const cases: [object, string, string][] = [
      [{ kind: "today" }, "2026-10-28", "2026-10-28"],
      [{ kind: "yesterday" }, "2026-10-27", "2026-10-27"],
      [{ kind: "last_week" }, "2026-10-19", "2026-10-25"],
      [{ kind: "this_month" }, "2026-10-01", "2026-10-31"],
      [{ kind: "last_month" }, "2026-09-01", "2026-09-30"],
      [{ kind: "last_days", n: 30 }, "2026-09-29", "2026-10-28"],
      [{ kind: "custom", dateFrom: "2026-10-05", dateTo: "2026-10-12" }, "2026-10-05", "2026-10-12"],
    ];
    for (const [period, from, to] of cases) {
      const { report } = await node({ reason: "x", ...period }).run(ask());
      expect([report.dateFrom, report.dateTo], JSON.stringify(period)).toEqual([from, to]);
      expect(report.notice).toBeUndefined();
    }
  });

  it("le pasa al modelo la fecha de hoy y la conversación reciente", async () => {
    const planner = fakePlanner({ reason: "x", kind: "today" });
    await makePlanReportNode(planner.model as never, { now: () => NOW })(ask("quiero el cierre"));
    const [system, human] = planner.calls[0] as { text: string }[];
    expect(system!.text).toContain("miércoles 28 de octubre de 2026");
    expect(system!.text).not.toContain("{{");
    expect(human!.text).toContain("[persona] quiero el cierre");
  });

  it("R5: una salida inválida cae en la semana actual y avisa", async () => {
    const invalid: unknown[] = [
      null,
      undefined,
      {},
      { reason: "x", kind: "next_week" },
      { reason: "x", kind: "last_days" }, // falta n
      { reason: "x", kind: "last_days", n: 500 },
      { reason: "x", kind: "custom", dateFrom: "2026-10-05" }, // falta dateTo
      { reason: "x", kind: "custom", dateFrom: "2026-10-12", dateTo: "2026-10-05" }, // al revés
      { reason: "x", kind: "custom", dateFrom: "2024-01-01", dateTo: "2026-10-05" }, // más de 366 días
      { reason: "x", kind: "custom", dateFrom: "05/10", dateTo: "12/10" },
    ];
    for (const parsed of invalid) {
      const { run, warn } = node(parsed);
      const { report } = await run(ask());
      expect([report.dateFrom, report.dateTo], JSON.stringify(parsed)).toEqual(["2026-10-26", "2026-11-01"]);
      expect(report.notice, JSON.stringify(parsed)).toBe(PLAN_FALLBACK_NOTICE);
      expect(warn).toHaveBeenCalledTimes(2); // fase 10: el segundo intento y el respaldo
    }
  });

  it("un error real de la API no se tapa", async () => {
    const model = { async invoke() { throw new Error("529 overloaded"); } };
    await expect(makePlanReportNode(model as never, { now: () => NOW })(ask())).rejects.toThrow(/529/);
  });

  it("cada reporte tiene un id distinto", async () => {
    const run = makePlanReportNode(fakePlanner({ reason: "x", kind: "today" }).model as never, { now: () => NOW });
    const [a, b] = [await run(ask()), await run(ask())];
    expect(a.report.id).not.toBe(b.report.id);
  });
});

describe("fan-out", () => {
  it("devuelve un Send por sección, cada uno con solo lo que necesita", () => {
    const state = makeState([], { report: { id: "r1", dateFrom: "2026-10-26", dateTo: "2026-11-01", label: "x" } });
    const sends = fanOutReport(state);
    expect(sends.map((s) => s.node).sort()).toEqual(Object.values(SECTION_NODES).sort());
    for (const send of sends) expect(send.args).toEqual({ reportId: "r1", dateFrom: "2026-10-26", dateTo: "2026-11-01" });
  });

  it("sin reporte planificado no hay nada que lanzar", () => {
    expect(() => fanOutReport(makeState([]))).toThrow(/reporte planificado/);
  });
});

describe("nodo de sección", () => {
  it("escribe su parte en reportParts", async () => {
    const run = vi.fn(async (section, reportId): Promise<ReportPart> => ({ reportId, section, status: "ok", data: { n: 1 } }));
    const update = await makeSectionNode("stock", run)({ reportId: "r1", dateFrom: "2026-10-26", dateTo: "2026-11-01" });
    expect(update).toEqual({ reportParts: [{ reportId: "r1", section: "stock", status: "ok", data: { n: 1 } }] });
    expect(run).toHaveBeenCalledWith("stock", "r1", { dateFrom: "2026-10-26", dateTo: "2026-11-01" });
  });
});

describe("compose_report", () => {
  const report = { id: "r1", dateFrom: "2026-10-26", dateTo: "2026-11-01", label: "semana del 26/10 al 01/11" };
  const ok = (section: ReportPart["section"], data: unknown): ReportPart => ({ reportId: "r1", section, status: "ok", data });
  const sales = { salesCount: 38, totalRevenue: 312_400, averageTicket: 8_221, byPaymentMethod: [{ method: "cash", count: 38, total: 312_400 }], byItemType: { products: { units: 31, revenue: 112_400 }, services: { units: 25, revenue: 200_000 } } };
  const appts = { total: 120, activeCount: 112, countByStatus: { scheduled: 112, cancelled: 8 } };
  const stock = { total: 15, lowCount: 1, low: [{ name: "Pomada clásica", sku: "POM-001", stock: 3, minStock: 5 }] };
  const all = [ok("sales", sales), ok("appointments", appts), ok("stock", stock)];
  const state = (parts: ReportPart[]) => makeState([], { report, reportParts: parts });
  const model = (reply: string | Error): AgentModel & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return { calls, async invoke(messages) { calls.push(messages); if (reply instanceof Error) throw reply; return new AIMessage(reply); } };
  };
  const warn = () => vi.fn();

  it("el texto con las cifras sale del código y la «Lectura» del modelo va al final", async () => {
    const m = model("• Casi todo se cobró en efectivo.\n• Falta reponer pomada.");
    const { messages } = await makeComposeReportNode(m, { warn: warn() })(state(all));
    const text = messages[0]!.text;
    expect(text.startsWith("Reporte · semana del 26/10 al 01/11")).toBe(true);
    expect(text).toContain("38 ventas por $ 312.400");
    expect(text).toContain("Pomada clásica (POM-001): 3 de 5");
    expect(text.endsWith("\n\nLectura\n• Casi todo se cobró en efectivo.\n• Falta reponer pomada.")).toBe(true);
  });

  it("le manda al modelo las secciones en JSON y el período, no el reporte ya armado", async () => {
    const m = model("• ok");
    await makeComposeReportNode(m, { warn: warn() })(state(all));
    const [system, human] = m.calls[0] as { text: string }[];
    expect(system!.text).toContain("Lectura");
    expect(human!.text).toContain("semana del 26/10 al 01/11");
    expect(JSON.parse(human!.text.split("(JSON):\n")[1]!)).toMatchObject({ sales: { salesCount: 38 }, appointments: { total: 120 }, stock: { lowCount: 1 } });
  });

  it("CA3: una sección que falta se informa y las otras salen; el modelo recibe el motivo, no datos inventados", async () => {
    const m = model("• Faltan los turnos.");
    const parts: ReportPart[] = [ok("sales", sales), { reportId: "r1", section: "appointments", status: "error", error: "El rango no puede superar 31 días" }, ok("stock", stock)];
    const { messages } = await makeComposeReportNode(m, { warn: warn() })(state(parts));
    expect(messages[0]!.text).toContain("• No disponible: El rango no puede superar 31 días.");
    expect(messages[0]!.text).toContain("38 ventas");
    expect(String((m.calls[0] as { text: string }[])[1]!.text)).toContain('"appointments":{"noDisponible":"El rango no puede superar 31 días"}');
  });

  it("CA3: si fallan las tres no llama al modelo y el reporte lo dice", async () => {
    const m = model("no debería llamarse");
    const failed = (section: ReportPart["section"]): ReportPart => ({ reportId: "r1", section, status: "error", error: "problema del sistema" });
    const { messages } = await makeComposeReportNode(m, { warn: warn() })(state([failed("sales"), failed("appointments"), failed("stock")]));
    expect(m.calls).toHaveLength(0);
    expect(messages[0]!.text).toContain("No se pudo armar ninguna de las tres secciones.");
    expect(messages[0]!.text).not.toContain("Lectura");
  });

  it("CA3: si falla la llamada de la «Lectura», el reporte sale completo con un aviso", async () => {
    const w = warn();
    const { messages } = await makeComposeReportNode(model(new Error("529 overloaded")), { warn: w })(state(all));
    const text = messages[0]!.text;
    expect(text).toContain("38 ventas por $ 312.400");
    expect(text.endsWith(READING_FAILED_NOTICE)).toBe(true);
    expect(text).not.toContain("\nLectura\n");
    expect(w).toHaveBeenCalledOnce();
  });

  it("CA7: una «Lectura» con una cifra que no está en los datos se descarta", async () => {
    const w = warn();
    const { messages } = await makeComposeReportNode(model("• Las ventas subieron un 23 % respecto de la semana pasada."), { warn: w })(state(all));
    const text = messages[0]!.text;
    expect(text.endsWith(READING_DISCARDED_NOTICE)).toBe(true);
    expect(text).not.toContain("23 %");
    expect(w).toHaveBeenCalledOnce();
  });

  it("una «Lectura» que solo cita cifras del reporte se conserva, con o sin separadores de miles", async () => {
    const { messages } = await makeComposeReportNode(model("• Se facturaron $ 312.400 en 38 ventas; 8 turnos cancelados."), { warn: warn() })(state(all));
    expect(messages[0]!.text).toContain("Lectura\n• Se facturaron $ 312.400");
  });

  it("una «Lectura» vacía no agrega nada", async () => {
    const { messages } = await makeComposeReportNode(model("   "), { warn: warn() })(state(all));
    expect(messages[0]!.text).not.toContain("Lectura");
    expect(messages[0]!.text).not.toContain("(No pude");
  });

  it("sin reporte planificado falla con un mensaje claro", async () => {
    await expect(makeComposeReportNode(model("x"))(makeState([]))).rejects.toThrow(/reporte planificado/);
  });
});

describe("numbersIn / unknownNumbers", () => {
  it("normaliza separadores de miles y decimales", () => {
    expect(numbersIn("Total $ 1.569.100 en 38 ventas, ticket 8,5 y 26/10")).toEqual(["1569100", "38", "85", "26", "10"]);
    expect(numbersIn("sin cifras")).toEqual([]);
    expect(numbersIn("Fin de frase 2026.")).toEqual(["2026"]);
  });

  it("encuentra solo las cifras que no estaban en la fuente", () => {
    expect(unknownNumbers("vendimos 312400 en 38 ventas", "38 ventas por $ 312.400")).toEqual([]);
    expect(unknownNumbers("subió 23 y 5", "5 productos")).toEqual(["23"]);
  });
});
