import { describe, expect, it } from "vitest";
import { getSalesSummary, getSalesSummaryInput } from "../../src/tools/get-sales-summary.js";
import { hasDb, useDatabases } from "./helpers.js";

const AR = `'America/Argentina/Buenos_Aires'`;

describe.skipIf(!hasDb)("getSalesSummary", () => {
  const ctx = useDatabases();

  /** Día local (YYYY-MM-DD) a `offset` días de hoy, según la propia base. */
  const rel = async (offset: number) =>
    (await ctx.sql.query(`SELECT ((now() AT TIME ZONE ${AR})::date + $1::int)::text AS d`, [offset])).rows[0].d as string;

  it("coincide con SQL independiente en los últimos 7 días", async () => {
    const [dateFrom, dateTo] = [await rel(-7), await rel(-1)];
    const r = await getSalesSummary(ctx.db, { dateFrom, dateTo });

    const day = `(created_at AT TIME ZONE ${AR})::date BETWEEN $1::date AND $2::date`;
    const totals = (
      await ctx.sql.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::int AS t FROM sales WHERE ${day}`, [dateFrom, dateTo])
    ).rows[0];
    const methods = (
      await ctx.sql.query(
        `SELECT payment_method AS m, COUNT(*)::int AS n, SUM(total)::int AS t FROM sales WHERE ${day} GROUP BY 1 ORDER BY 1`,
        [dateFrom, dateTo],
      )
    ).rows;
    const items = (
      await ctx.sql.query(
        `SELECT (si.product_id IS NOT NULL) AS p, SUM(si.qty)::int AS units, SUM(si.qty * si.unit_price)::int AS rev
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE (s.created_at AT TIME ZONE ${AR})::date BETWEEN $1::date AND $2::date GROUP BY 1`,
        [dateFrom, dateTo],
      )
    ).rows;

    expect(r.salesCount).toBe(totals.n);
    expect(r.totalRevenue).toBe(totals.t);
    expect(r.salesCount).toBeGreaterThan(0);
    expect(r.averageTicket).toBe(Math.round(totals.t / totals.n));
    const byName = (a: { method: string }, b: { method: string }) => a.method.localeCompare(b.method);
    expect([...r.byPaymentMethod].sort(byName)).toEqual(
      methods.map((x) => ({ method: x.m, count: x.n, total: x.t })).sort(byName),
    );
    // La herramienta ordena de mayor a menor total.
    const totalsDesc = r.byPaymentMethod.map((m) => m.total);
    expect(totalsDesc).toEqual([...totalsDesc].sort((a, b) => b - a));
    const prod = items.find((x) => x.p);
    const serv = items.find((x) => !x.p);
    expect(r.byItemType.products).toEqual({ units: prod.units, revenue: prod.rev });
    expect(r.byItemType.services).toEqual({ units: serv.units, revenue: serv.rev });
  });

  it("los desgloses suman lo mismo que el total", async () => {
    const r = await getSalesSummary(ctx.db, { dateFrom: await rel(-30), dateTo: await rel(-1) });
    expect(r.byPaymentMethod.reduce((s, m) => s + m.total, 0)).toBe(r.totalRevenue);
    expect(r.byPaymentMethod.reduce((s, m) => s + m.count, 0)).toBe(r.salesCount);
    expect(r.byItemType.products.revenue + r.byItemType.services.revenue).toBe(r.totalRevenue);
  });

  it("un rango sin ventas da ceros y ticket promedio 0", async () => {
    const r = await getSalesSummary(ctx.db, { dateFrom: await rel(5), dateTo: await rel(6) });
    expect(r).toMatchObject({
      salesCount: 0,
      totalRevenue: 0,
      averageTicket: 0,
      byPaymentMethod: [],
      byItemType: { products: { units: 0, revenue: 0 }, services: { units: 0, revenue: 0 } },
    });
  });

  it("un solo día cuenta de 00:00 a 23:59 hora de Argentina", async () => {
    const yesterday = await rel(-1);
    const one = await getSalesSummary(ctx.db, { dateFrom: yesterday, dateTo: yesterday });
    const { rows } = await ctx.sql.query(
      `SELECT COUNT(*)::int AS n FROM sales WHERE (created_at AT TIME ZONE ${AR})::date = $1::date`,
      [yesterday],
    );
    expect(one.salesCount).toBe(rows[0].n);
  });
});

describe("getSalesSummaryInput", () => {
  it("acepta hasta 92 días y rechaza más", () => {
    expect(getSalesSummaryInput.safeParse({ dateFrom: "2026-07-01", dateTo: "2026-09-30" }).success).toBe(true); // 92 días
    expect(getSalesSummaryInput.safeParse({ dateFrom: "2026-07-01", dateTo: "2026-10-01" }).success).toBe(false); // 93 días
  });

  it("rechaza rangos invertidos, fechas inexistentes y parámetros desconocidos", () => {
    expect(getSalesSummaryInput.safeParse({ dateFrom: "2026-10-05", dateTo: "2026-10-01" }).success).toBe(false);
    expect(getSalesSummaryInput.safeParse({ dateFrom: "2026-02-30", dateTo: "2026-03-01" }).success).toBe(false);
    expect(getSalesSummaryInput.safeParse({ dateFrom: "2026-10-01", dateTo: "2026-10-02", groupBy: "day" }).success).toBe(false);
  });
});
