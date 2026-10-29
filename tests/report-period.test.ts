import { describe, expect, it } from "vitest";
import { DEFAULT_PERIOD, MAX_PERIOD_DAYS, periodDays, periodSchema, PeriodError, resolvePeriod, type Period } from "../src/graph/report/period.js";

/** Mediodía en Argentina (15:00 UTC) del día indicado. */
const noon = (day: string) => new Date(`${day}T15:00:00Z`);
const resolve = (period: Period, day: string) => {
  const r = resolvePeriod(period, noon(day));
  return [r.dateFrom, r.dateTo];
};

describe("resolvePeriod", () => {
  it("hoy y ayer", () => {
    expect(resolve({ kind: "today" }, "2026-10-28")).toEqual(["2026-10-28", "2026-10-28"]);
    expect(resolve({ kind: "yesterday" }, "2026-10-28")).toEqual(["2026-10-27", "2026-10-27"]);
    expect(resolve({ kind: "yesterday" }, "2026-03-01")).toEqual(["2026-02-28", "2026-02-28"]); // cruza de mes
    expect(resolve({ kind: "yesterday" }, "2026-01-01")).toEqual(["2025-12-31", "2025-12-31"]); // cruza de año
  });

  it("la semana va de lunes a domingo, sea cual sea el día de hoy", () => {
    // 2026-10-26 es lunes y 2026-11-01 es domingo.
    for (const today of ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]) {
      expect(resolve({ kind: "this_week" }, today), today).toEqual(["2026-10-26", "2026-11-01"]);
      expect(resolve({ kind: "last_week" }, today), today).toEqual(["2026-10-19", "2026-10-25"]);
    }
    expect(resolve({ kind: "this_week" }, "2026-11-02")).toEqual(["2026-11-02", "2026-11-08"]); // el lunes siguiente empieza otra
  });

  it("la semana cruza el cambio de año", () => {
    expect(resolve({ kind: "this_week" }, "2026-01-01")).toEqual(["2025-12-29", "2026-01-04"]);
    expect(resolve({ kind: "last_week" }, "2026-01-01")).toEqual(["2025-12-22", "2025-12-28"]);
  });

  it("este mes y el mes pasado, con meses de 28, 29, 30 y 31 días", () => {
    expect(resolve({ kind: "this_month" }, "2026-10-28")).toEqual(["2026-10-01", "2026-10-31"]);
    expect(resolve({ kind: "this_month" }, "2026-02-10")).toEqual(["2026-02-01", "2026-02-28"]);
    expect(resolve({ kind: "this_month" }, "2028-02-29")).toEqual(["2028-02-01", "2028-02-29"]); // bisiesto
    expect(resolve({ kind: "this_month" }, "2026-04-30")).toEqual(["2026-04-01", "2026-04-30"]);
    expect(resolve({ kind: "last_month" }, "2026-10-28")).toEqual(["2026-09-01", "2026-09-30"]);
    expect(resolve({ kind: "last_month" }, "2028-03-15")).toEqual(["2028-02-01", "2028-02-29"]);
    expect(resolve({ kind: "last_month" }, "2026-01-05")).toEqual(["2025-12-01", "2025-12-31"]); // cruza de año
    expect(resolve({ kind: "last_month" }, "2026-03-31")).toEqual(["2026-02-01", "2026-02-28"]);
  });

  it("los últimos N días incluyen hoy", () => {
    expect(resolve({ kind: "last_days", n: 1 }, "2026-10-28")).toEqual(["2026-10-28", "2026-10-28"]);
    expect(resolve({ kind: "last_days", n: 7 }, "2026-10-28")).toEqual(["2026-10-22", "2026-10-28"]);
    expect(resolve({ kind: "last_days", n: 30 }, "2026-10-28")).toEqual(["2026-09-29", "2026-10-28"]);
    expect(resolve({ kind: "last_days", n: 92 }, "2026-10-28")).toEqual(["2026-07-29", "2026-10-28"]);
    expect(periodDays(resolvePeriod({ kind: "last_days", n: 30 }, noon("2026-10-28")))).toBe(30);
  });

  it("un período personalizado se usa tal cual", () => {
    expect(resolve({ kind: "custom", dateFrom: "2026-10-05", dateTo: "2026-10-12" }, "2026-10-28")).toEqual(["2026-10-05", "2026-10-12"]);
    expect(resolve({ kind: "custom", dateFrom: "2026-10-05", dateTo: "2026-10-05" }, "2026-10-28")).toEqual(["2026-10-05", "2026-10-05"]);
    expect(periodDays({ dateFrom: "2026-01-01", dateTo: "2026-12-31" })).toBe(365);
  });

  it("un período personalizado inválido se rechaza", () => {
    expect(() => resolvePeriod({ kind: "custom", dateFrom: "2026-10-12", dateTo: "2026-10-05" }, noon("2026-10-28"))).toThrow(PeriodError);
    // 366 días entran; 367 no.
    expect(() => resolvePeriod({ kind: "custom", dateFrom: "2025-10-28", dateTo: "2026-10-28" }, noon("2026-10-28"))).not.toThrow();
    expect(() => resolvePeriod({ kind: "custom", dateFrom: "2025-10-27", dateTo: "2026-10-28" }, noon("2026-10-28"))).toThrow(
      new RegExp(`${MAX_PERIOD_DAYS}`),
    );
  });

  it("usa siempre el horario de Argentina para saber qué día es hoy", () => {
    // 23:00 del 28/10 en Argentina ya es el 29 en UTC: hoy sigue siendo 28.
    expect(resolve({ kind: "today" }, "2026-10-28")).toEqual(["2026-10-28", "2026-10-28"]);
    expect(resolvePeriod({ kind: "today" }, new Date("2026-10-29T02:30:00Z")).dateFrom).toBe("2026-10-28");
    expect(resolvePeriod({ kind: "today" }, new Date("2026-10-29T02:59:59Z")).dateFrom).toBe("2026-10-28");
    expect(resolvePeriod({ kind: "today" }, new Date("2026-10-29T03:00:00Z")).dateFrom).toBe("2026-10-29"); // medianoche local
    expect(resolvePeriod({ kind: "today" }, new Date("2026-10-28T02:59:59Z")).dateFrom).toBe("2026-10-27");
    // La semana y el mes también: el domingo 1/11 a las 23:30 locales, en UTC ya es lunes 2/11.
    expect(resolvePeriod({ kind: "this_week" }, new Date("2026-11-02T02:30:00Z")).dateFrom).toBe("2026-10-26");
    expect(resolvePeriod({ kind: "this_month" }, new Date("2026-11-01T02:30:00Z")).dateFrom).toBe("2026-10-01");
  });

  it("el período por defecto es la semana actual", () => {
    expect(DEFAULT_PERIOD).toEqual({ kind: "this_week" });
  });
});

describe("etiquetas", () => {
  const label = (period: Period, day = "2026-10-28") => resolvePeriod(period, noon(day)).label;

  it("dicen qué período cubre el reporte, con fechas explícitas", () => {
    expect(label({ kind: "today" })).toBe("hoy, mié 28/10"); // el 28/10/2026 es miércoles
    expect(label({ kind: "yesterday" })).toBe("ayer, mar 27/10");
    expect(label({ kind: "this_week" })).toBe("semana del 26/10 al 01/11");
    expect(label({ kind: "last_week" })).toBe("semana pasada, del 19/10 al 25/10");
    expect(label({ kind: "this_month" })).toBe("octubre de 2026");
    expect(label({ kind: "last_month" })).toBe("septiembre de 2026");
    expect(label({ kind: "last_days", n: 30 })).toBe("últimos 30 días, del 29/09 al 28/10");
    expect(label({ kind: "last_days", n: 1 })).toBe("hoy, mié 28/10"); // un solo día es hoy
    expect(label({ kind: "custom", dateFrom: "2026-10-05", dateTo: "2026-10-12" })).toBe("del 05/10 al 12/10");
  });

  it("agrega el año cuando no es el actual", () => {
    expect(label({ kind: "custom", dateFrom: "2025-12-20", dateTo: "2026-01-05" })).toBe("del 20/12/2025 al 05/01");
    expect(label({ kind: "last_week" }, "2026-01-01")).toBe("semana pasada, del 22/12/2025 al 28/12/2025");
    expect(label({ kind: "last_month" }, "2026-01-05")).toBe("diciembre de 2025");
  });
});

describe("periodSchema", () => {
  it("acepta las ocho formas y rechaza lo demás", () => {
    const ok: unknown[] = [
      { kind: "today" },
      { kind: "yesterday" },
      { kind: "this_week" },
      { kind: "last_week" },
      { kind: "this_month" },
      { kind: "last_month" },
      { kind: "last_days", n: 30 },
      { kind: "custom", dateFrom: "2026-10-05", dateTo: "2026-10-12" },
    ];
    for (const p of ok) expect(periodSchema.safeParse(p).success, JSON.stringify(p)).toBe(true);

    const bad: unknown[] = [
      { kind: "next_week" },
      { kind: "last_days" },
      { kind: "last_days", n: 0 },
      { kind: "last_days", n: 93 },
      { kind: "last_days", n: 1.5 },
      { kind: "last_days", n: "30" },
      { kind: "today", extra: 1 },
      { kind: "custom", dateFrom: "2026-02-30", dateTo: "2026-03-01" },
      { kind: "custom", dateFrom: "5/10", dateTo: "12/10" },
      { kind: "custom", dateFrom: "2026-10-05" },
      {},
      null,
      "this_week",
    ];
    for (const p of bad) expect(periodSchema.safeParse(p).success, JSON.stringify(p)).toBe(false);
  });
});
