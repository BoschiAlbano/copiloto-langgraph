import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import { runSection } from "../src/graph/report/sections.js";
import type { AppointmentsData, SalesData, StockData } from "../src/graph/report/state.js";
import { hasDb, useDatabases } from "./tools/helpers.js";

afterEach(() => vi.restoreAllMocks());

// Un cliente de base que falla como lo haría una base caída o sin permisos (con un texto que no debe filtrarse).
const leaky = new Error('password authentication failed for user "copilot_reader" at db.internal:5432');
const brokenRaw = {
  $queryRaw: async () => {
    throw Object.assign(leaky, { code: "P1000" });
  },
  sale: { aggregate: async () => { throw leaky; }, groupBy: async () => { throw leaky; } },
  appointment: { findMany: async () => { throw leaky; }, groupBy: async () => { throw leaky; } },
} as unknown as Db;

const range = { dateFrom: "2026-10-26", dateTo: "2026-11-01" };

describe("secciones que fallan (CA3)", () => {
  it("cada sección devuelve una parte con error en vez de lanzar, y no filtra detalles internos", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const section of ["sales", "appointments", "stock"] as const) {
      const part = await runSection(section, "r1", range, brokenRaw);
      expect(part, section).toMatchObject({ reportId: "r1", section, status: "error" });
      expect(part.error, section).toContain("problema del sistema");
      expect(part.error, section).not.toMatch(/password|copilot_reader|db\.internal|5432/);
      expect(part.data).toBeUndefined();
    }
    // El detalle completo sí va a la consola de quien opera el sistema.
    expect(quiet.mock.calls.map((c) => String(c[0])).join("\n")).toContain("copilot_reader");
  });

  it("el código de la base se informa sin el texto interno", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const part = await runSection("stock", "r1", range, brokenRaw);
    expect(part.error).toBe("problema del sistema (código P1000)");
  });

  it("un límite de la herramienta se informa tal cual: los turnos admiten hasta 31 días", async () => {
    const part = await runSection("appointments", "r1", { dateFrom: "2026-08-01", dateTo: "2026-10-31" }, {} as Db);
    expect(part).toMatchObject({ status: "error", section: "appointments" });
    expect(part.error).toMatch(/31 días/);
  });

  it("un límite de ventas: hasta 92 días", async () => {
    const part = await runSection("sales", "r1", { dateFrom: "2026-01-01", dateTo: "2026-10-31" }, {} as Db);
    expect(part.status).toBe("error");
    expect(part.error).toMatch(/92 días/);
  });
});

describe.skipIf(!hasDb)("secciones con la base real", () => {
  const ctx = useDatabases();

  it("ventas: los totales coinciden con una consulta independiente", async () => {
    const part = await runSection("sales", "r1", { dateFrom: "2026-09-01", dateTo: "2026-10-31" }, ctx.db);
    expect(part.status).toBe("ok");
    const data = part.data as SalesData;
    const { rows } = await ctx.sql.query(
      `SELECT COUNT(*)::int n, COALESCE(SUM(total),0)::int total FROM sales
        WHERE (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN '2026-09-01' AND '2026-10-31'`,
    );
    expect(data.salesCount).toBe(rows[0].n);
    expect(data.totalRevenue).toBe(rows[0].total);
    expect(data.byPaymentMethod.reduce((s, m) => s + m.total, 0)).toBe(rows[0].total);
  });

  it("turnos: solo totales por estado, sin filas", async () => {
    const part = await runSection("appointments", "r1", { dateFrom: "2026-10-01", dateTo: "2026-10-31" }, ctx.db);
    expect(part.status).toBe("ok");
    const data = part.data as AppointmentsData;
    expect(Object.keys(data).sort()).toEqual(["activeCount", "countByStatus", "total"]);
    expect(Object.values(data.countByStatus).reduce((a, b) => a + b, 0)).toBe(data.total);
    expect(data.activeCount).toBe(data.total - (data.countByStatus.cancelled ?? 0));
  });

  it("stock: productos bajo el mínimo, con el total del catálogo", async () => {
    const part = await runSection("stock", "r1", range, ctx.db);
    const data = part.data as StockData;
    const { rows } = await ctx.sql.query(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE stock < min_stock)::int low FROM products`);
    expect(data.total).toBe(rows[0].total);
    expect(data.lowCount).toBe(rows[0].low);
    expect(data.low).toHaveLength(rows[0].low);
    for (const p of data.low) expect(p.stock).toBeLessThan(p.minStock);
  });

  it("el período de las secciones de ventas y turnos se interpreta en horario de Argentina", async () => {
    const part = await runSection("appointments", "r1", { dateFrom: "2026-10-28", dateTo: "2026-10-28" }, ctx.db);
    const { rows } = await ctx.sql.query(
      `SELECT COUNT(*)::int n FROM appointments WHERE (starts_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = '2026-10-28'`,
    );
    expect((part.data as AppointmentsData).total).toBe(rows[0].n);
  });
});
