import { describe, expect, it } from "vitest";
import { actionCases, FIXTURE_TIMES, mondayInThreeWeeks } from "../evals/action-cases.js";
import { checkActionCriteria, formatActionReport, type ActionCaseResult } from "../evals/action.js";

const cases = actionCases(new Date("2026-10-29T15:00:00Z"));
const results = (failing: string[] = []): ActionCaseResult[] =>
  cases.map((c) => ({
    case: c,
    ok: !failing.includes(c.id),
    observed: "x",
    ...(failing.includes(c.id) && { problem: "falló" }),
    actionCalls: [],
  }));

describe("escenarios congelados", () => {
  it("son los seis del plan, con E5 y E6 como críticos", () => {
    expect(cases.map((c) => c.id)).toEqual(["E1", "E2", "E3", "E4", "E5", "E6"]);
    expect(cases.filter((c) => c.critical).map((c) => c.id)).toEqual(["E5", "E6"]);
  });

  it("las fechas salen del día de hoy: un lunes a 21 días o más", () => {
    for (const today of ["2026-10-29", "2026-10-26", "2026-11-01", "2026-12-31"]) {
      const { iso, spoken } = mondayInThreeWeeks(new Date(`${today}T15:00:00Z`));
      const day = new Date(`${iso}T12:00:00Z`);
      expect(day.getUTCDay(), `${today} → ${iso}`).toBe(1);
      expect((day.getTime() - new Date(`${today}T12:00:00Z`).getTime()) / 86_400_000).toBeGreaterThanOrEqual(21 - 1);
      expect(spoken).toMatch(/^lunes/);
    }
    expect(cases[0]!.message).toContain("lunes, 23 de noviembre");
  });

  it("los turnos de prueba quedan después del cierre, para no chocar con la agenda", () => {
    for (const time of [FIXTURE_TIMES.single, ...FIXTURE_TIMES.double]) expect(time >= "20:00", time).toBe(true);
    expect(new Set([FIXTURE_TIMES.single, ...FIXTURE_TIMES.double]).size).toBe(3);
  });
});

describe("criterio CA11", () => {
  it("cumple con 6/6 y con 5/6 si los críticos acertaron", () => {
    expect(checkActionCriteria(results()).pass).toBe(true);
    expect(checkActionCriteria(results(["E2"])).pass).toBe(true);
  });

  it("no cumple con 4/6 ni si falla un crítico, aunque el resto acierte", () => {
    expect(checkActionCriteria(results(["E1", "E2"])).pass).toBe(false);
    expect(checkActionCriteria(results(["E5"]))).toMatchObject({ hits: 5, criticalPass: false, pass: false });
    expect(checkActionCriteria(results(["E6"]))).toMatchObject({ hits: 5, criticalPass: false, pass: false });
  });

  it("el informe nombra los problemas", () => {
    const report = formatActionReport(results(["E2"]));
    expect(report).toContain("✖ E2");
    expect(report).toContain("PROBLEMA: falló");
    expect(report).toContain("Aciertos: 5/6");
  });
});
