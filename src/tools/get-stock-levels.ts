import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { Prisma } from "../db/generated/client.js";
import { safeTool } from "./safe.js";
import { ACCENTS_FROM, ACCENTS_TO, normalize } from "./text.js";

export const MAX_PRODUCTS = 50;

export const getStockLevelsInput = z.strictObject({
  onlyLow: z.boolean().optional().describe("true para ver solo los productos con stock por debajo del mínimo"),
  query: z.string().trim().min(1).max(60).optional().describe("Parte del nombre o del sku (opcional)"),
});

interface ProductRow {
  id: number;
  name: string;
  sku: string;
  stock: number;
  minStock: number;
  isLow: boolean;
}

const fold = (column: Prisma.Sql) =>
  Prisma.sql`translate(lower(${column}), ${ACCENTS_FROM}, ${ACCENTS_TO})`;

export async function getStockLevels(
  db: Db,
  input: z.input<typeof getStockLevelsInput> = {},
  options: { limit?: number } = {},
) {
  const { onlyLow, query } = getStockLevelsInput.parse(input);
  const limit = options.limit ?? MAX_PRODUCTS;

  const filters: Prisma.Sql[] = [];
  if (onlyLow) filters.push(Prisma.sql`stock < min_stock`);
  if (query) {
    const text = `%${normalize(query).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    filters.push(Prisma.sql`(${fold(Prisma.sql`name`)} LIKE ${text} OR lower(sku) LIKE ${text})`);
  }
  const where = filters.length ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}` : Prisma.empty;

  const [rows, totals] = await Promise.all([
    db.$queryRaw<ProductRow[]>`
      SELECT id, name, sku, stock, min_stock AS "minStock", (stock < min_stock) AS "isLow"
      FROM products ${where}
      ORDER BY (stock < min_stock) DESC, (stock - min_stock) ASC, name
      LIMIT ${limit}`,
    db.$queryRaw<{ total: number; lowCount: number }[]>`
      SELECT COUNT(*)::int AS total, (COUNT(*) FILTER (WHERE stock < min_stock))::int AS "lowCount"
      FROM products ${where}`,
  ]);
  const { total = 0, lowCount = 0 } = totals[0] ?? {};

  return { total, lowCount, truncated: total > rows.length, products: rows };
}

export const makeGetStockLevelsTool = (db: Db) =>
  tool(safeTool("getStockLevels", (input: z.input<typeof getStockLevelsInput>) => getStockLevels(db, input)), {
    name: "getStockLevels",
    description:
      "Consulta el stock de productos. Un producto está 'bajo' (isLow) cuando su stock es menor que su mínimo. " +
      "Podés pedir solo los bajos (onlyLow) o buscar por nombre o sku. Devuelve `total`, `lowCount` (cuántos están bajos " +
      `entre los que coinciden) y hasta ${MAX_PRODUCTS} productos, con los más urgentes primero.`,
    schema: getStockLevelsInput,
  });
