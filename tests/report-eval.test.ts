import { describe, expect, it } from "vitest";
import { checkPlanCriteria, evaluatePlanner, formatPlanReport, type PlanCaseResult } from "../evals/report.js";
import { REPORT_CASES, REPORT_NOW } from "../evals/report-cases.js";
import { resolvePeriod, type Period } from "../src/graph/report/period.js";

/** Un planificador falso que contesta lo indicado para cada pedido (y `kind: "this_week"` para el resto). */
function fakePlanner(answers: Record<string, object>) {
  return {
    async invoke(messages: { text: string }[]) {
      const text = messages[1]!.text;
      const message = REPORT_CASES.find((c) => text.includes(`[persona] ${c.message}`))?.message ?? "";
      return { parsed: { reason: "x", ...(answers[message] ?? { kind: "this_week" }) } };
    },
  };
}

// Las respuestas correctas, en forma simbólica.
const CORRECT: Record<string, object> = {
  "Armame el resumen de la semana.": { kind: "this_week" },
  "Haceme un reporte del mes con ventas, turnos y stock.": { kind: "this_month" },
  "Quiero un informe de cierre del día.": { kind: "today" },
  "Dame un panorama completo del negocio de los últimos 30 días.": { kind: "last_days", n: 30 },
  "Resumen de la semana pasada.": { kind: "last_week" },
  "Hacé un resumen.": { kind: "this_week" },
  "Resumen del 5 al 12 de octubre.": { kind: "custom", dateFrom: "2026-10-05", dateTo: "2026-10-12" },
  "Cómo estuvo el mes pasado en general.": { kind: "last_month" },
};

describe("escenarios congelados del planificador", () => {
  it("son los ocho del plan, con P1, P3 y P6 como críticos", () => {
    expect(REPORT_CASES.map((c) => c.id)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]);
    expect(REPORT_CASES.filter((c) => c.critical).map((c) => c.id)).toEqual(["P1", "P3", "P6"]);
  });

  it("el reloj fijo es el miércoles 28/10/2026 y las fechas esperadas coinciden con el calendario", () => {
    expect(resolvePeriod({ kind: "today" }, REPORT_NOW).dateFrom).toBe("2026-10-28");
    const byKind = (kind: Period["kind"], extra: object = {}) => resolvePeriod({ kind, ...extra } as Period, REPORT_NOW);
    expect(byKind("this_week")).toMatchObject({ dateFrom: "2026-10-26", dateTo: "2026-11-01" });
    expect(byKind("last_week")).toMatchObject({ dateFrom: "2026-10-19", dateTo: "2026-10-25" });
    expect(byKind("this_month")).toMatchObject({ dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    expect(byKind("last_month")).toMatchObject({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    expect(byKind("last_days", { n: 30 })).toMatchObject({ dateFrom: "2026-09-29", dateTo: "2026-10-28" });
  });
});

describe("evaluatePlanner", () => {
  it("un planificador que elige bien acierta los ocho", async () => {
    const results = await evaluatePlanner(fakePlanner(CORRECT) as never);
    expect(results.map((r) => r.ok)).toEqual(Array(8).fill(true));
    expect(checkPlanCriteria(results)).toMatchObject({ hits: 8, criticalPass: true, pass: true });
  });

  it("un planificador que siempre elige la semana actual acierta P1 y P6 pero no cumple", async () => {
    const results = await evaluatePlanner(fakePlanner({}) as never);
    expect(results.filter((r) => r.ok).map((r) => r.case.id)).toEqual(["P1", "P6"]);
    expect(checkPlanCriteria(results).pass).toBe(false);
  });

  it("la salida inválida cuenta como error aunque el respaldo coincida con lo esperado (P6)", async () => {
    const invalid = { async invoke() { return { parsed: null }; } };
    const results = await evaluatePlanner(invalid as never);
    const p6 = results.find((r) => r.case.id === "P6")!;
    expect(p6.ok).toBe(false);
    expect(p6.problem).toMatch(/respaldo/);
  });

  it("acepta las dos lecturas de «últimos 30 días» y rechaza otras", async () => {
    const answers = (n: number) => ({ ...CORRECT, "Dame un panorama completo del negocio de los últimos 30 días.": { kind: "last_days", n } });
    for (const [n, ok] of [[30, true], [31, true], [29, false], [7, false]] as const) {
      const results = await evaluatePlanner(fakePlanner(answers(n)) as never, REPORT_CASES.filter((c) => c.id === "P4"));
      expect(results[0]!.ok, `n=${n}`).toBe(ok);
    }
  });
});

describe("criterio CA6", () => {
  const results = (failing: string[] = []): PlanCaseResult[] =>
    REPORT_CASES.map((c) => ({ case: c, ok: !failing.includes(c.id), observed: { dateFrom: "a", dateTo: "b", label: "x" }, ...(failing.includes(c.id) && { problem: "mal" }) }));

  it("cumple con 8/8 y con 7/8 si los críticos aciertan", () => {
    expect(checkPlanCriteria(results()).pass).toBe(true);
    expect(checkPlanCriteria(results(["P7"])).pass).toBe(true);
  });

  it("no cumple con 6/8, ni si falla un crítico", () => {
    expect(checkPlanCriteria(results(["P2", "P7"])).pass).toBe(false);
    for (const critical of ["P1", "P3", "P6"]) expect(checkPlanCriteria(results([critical])), critical).toMatchObject({ hits: 7, criticalPass: false, pass: false });
  });

  it("el informe nombra los problemas", () => {
    const report = formatPlanReport(results(["P7"]));
    expect(report).toContain("✖ P7");
    expect(report).toContain("PROBLEMA: mal");
    expect(report).toContain("Aciertos: 7/8");
  });
});
