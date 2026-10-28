import { describe, expect, it } from "vitest";
import {
  daysInRange,
  describeNow,
  formatLocal,
  localDateOf,
  localDateSchema,
  localDayRangeUtc,
} from "../../src/tools/dates.js";

describe("localDateSchema", () => {
  it("acepta fechas reales, incluido el 29 de febrero bisiesto", () => {
    expect(localDateSchema.safeParse("2026-10-28").success).toBe(true);
    expect(localDateSchema.safeParse("2028-02-29").success).toBe(true);
  });

  it("rechaza fechas que no existen o con formato raro", () => {
    for (const bad of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "28/10/2026", "2026-1-5", "mañana", ""]) {
      expect(localDateSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("localDayRangeUtc", () => {
  it("un día local de Argentina empieza a las 03:00 UTC", () => {
    const r = localDayRangeUtc("2026-10-28", "2026-10-28");
    expect(r.from.toISOString()).toBe("2026-10-28T03:00:00.000Z");
    expect(r.toExclusive.toISOString()).toBe("2026-10-29T03:00:00.000Z");
  });

  it("cruza fin de mes y de año", () => {
    expect(localDayRangeUtc("2026-10-31", "2026-11-01").toExclusive.toISOString()).toBe("2026-11-02T03:00:00.000Z");
    expect(localDayRangeUtc("2026-12-31", "2026-12-31").toExclusive.toISOString()).toBe("2027-01-01T03:00:00.000Z");
  });

  it("cubre varios días", () => {
    const r = localDayRangeUtc("2026-10-26", "2026-11-01");
    expect(r.toExclusive.getTime() - r.from.getTime()).toBe(7 * 86_400_000);
  });
});

describe("daysInRange", () => {
  it("cuenta ambos extremos", () => {
    expect(daysInRange("2026-10-28", "2026-10-28")).toBe(1);
    expect(daysInRange("2026-10-01", "2026-10-31")).toBe(31);
    expect(daysInRange("2026-10-31", "2026-11-01")).toBe(2);
  });
});

describe("formatLocal y localDateOf", () => {
  it("formatea con offset -03:00", () => {
    expect(formatLocal(new Date("2026-10-28T13:00:00Z"))).toBe("2026-10-28T10:00:00-03:00");
  });

  it("respeta el borde de medianoche local", () => {
    expect(formatLocal(new Date("2026-10-28T02:59:59Z"))).toBe("2026-10-27T23:59:59-03:00");
    expect(localDateOf(new Date("2026-10-28T02:59:59Z"))).toBe("2026-10-27");
    expect(localDateOf(new Date("2026-10-28T03:00:00Z"))).toBe("2026-10-28");
  });
});

describe("describeNow", () => {
  it("dice día de la semana, fecha y hora de Argentina", () => {
    const text = describeNow(new Date("2026-10-27T18:05:00Z"));
    expect(text).toContain("martes");
    expect(text).toContain("27 de octubre de 2026");
    expect(text).toContain("15:05");
    expect(text).toContain("hora de Argentina");
  });

  it("a las 01:00 UTC todavía es el día anterior en Argentina", () => {
    expect(describeNow(new Date("2026-10-28T01:00:00Z"))).toContain("27 de octubre");
  });
});
