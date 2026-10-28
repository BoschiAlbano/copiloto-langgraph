import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { daysInRange, localDateSchema, localDayRangeUtc } from "./dates.js";

export const MAX_RANGE_DAYS = 92;

export const getSalesSummaryInput = z
  .strictObject({
    dateFrom: localDateSchema.describe("Primer día, formato YYYY-MM-DD (hora de Argentina)"),
    dateTo: localDateSchema.describe("Último día incluido, formato YYYY-MM-DD. Para un solo día, igual a dateFrom"),
  })
  .refine((v) => v.dateFrom <= v.dateTo, { message: "dateFrom no puede ser posterior a dateTo" })
  .refine((v) => v.dateFrom > v.dateTo || daysInRange(v.dateFrom, v.dateTo) <= MAX_RANGE_DAYS, {
    message: `El rango no puede superar ${MAX_RANGE_DAYS} días`,
  });

export async function getSalesSummary(db: Db, input: z.input<typeof getSalesSummaryInput>) {
  const { dateFrom, dateTo } = getSalesSummaryInput.parse(input);
  const { from, toExclusive } = localDayRangeUtc(dateFrom, dateTo);
  const where = { createdAt: { gte: from, lt: toExclusive } };

  const [totals, byMethod, byItemType] = await Promise.all([
    db.sale.aggregate({ where, _count: { _all: true }, _sum: { total: true } }),
    db.sale.groupBy({ by: ["paymentMethod"], where, _count: { _all: true }, _sum: { total: true } }),
    db.$queryRaw<{ isProduct: boolean; units: number; revenue: number }[]>`
      SELECT (si.product_id IS NOT NULL) AS "isProduct",
             COALESCE(SUM(si.qty), 0)::int AS units,
             COALESCE(SUM(si.qty * si.unit_price), 0)::int AS revenue
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.created_at >= ${from} AND s.created_at < ${toExclusive}
      GROUP BY 1`,
  ]);

  const salesCount = totals._count._all;
  const totalRevenue = totals._sum.total ?? 0;
  const item = (isProduct: boolean) => {
    const row = byItemType.find((r) => r.isProduct === isProduct);
    return { units: row?.units ?? 0, revenue: row?.revenue ?? 0 };
  };

  return {
    period: { dateFrom, dateTo },
    currency: "ARS",
    salesCount,
    totalRevenue,
    averageTicket: salesCount ? Math.round(totalRevenue / salesCount) : 0,
    byPaymentMethod: byMethod
      .map((m) => ({ method: m.paymentMethod, count: m._count._all, total: m._sum.total ?? 0 }))
      .sort((a, b) => b.total - a.total || a.method.localeCompare(b.method)),
    byItemType: { products: item(true), services: item(false) },
  };
}

export const makeGetSalesSummaryTool = (db: Db) =>
  tool(async (input) => JSON.stringify(await getSalesSummary(db, input)), {
    name: "getSalesSummary",
    description:
      "Resume las ventas entre dos fechas (hora de Argentina, ambas incluidas, hasta 92 días): cantidad de ventas, " +
      "total facturado en pesos, ticket promedio, desglose por medio de pago y por tipo (productos o servicios). " +
      "Los números ya vienen calculados: no los recalcules.",
    schema: getSalesSummaryInput,
  });
