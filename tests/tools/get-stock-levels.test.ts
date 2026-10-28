import { describe, expect, it } from "vitest";
import { getStockLevels, getStockLevelsInput } from "../../src/tools/get-stock-levels.js";
import { hasDb, useDatabases } from "./helpers.js";

describe.skipIf(!hasDb)("getStockLevels", () => {
  const ctx = useDatabases();

  it("sin filtros devuelve los 15 productos con el conteo de bajos de la base", async () => {
    const r = await getStockLevels(ctx.db);
    const { rows } = await ctx.sql.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE stock < min_stock)::int AS low FROM products`,
    );
    expect(r.total).toBe(15);
    expect(r.products).toHaveLength(15);
    expect(r.truncated).toBe(false);
    expect(r.lowCount).toBe(rows[0].low);
  });

  it("onlyLow devuelve exactamente los productos bajo el mínimo", async () => {
    const r = await getStockLevels(ctx.db, { onlyLow: true });
    const { rows } = await ctx.sql.query(`SELECT sku FROM products WHERE stock < min_stock ORDER BY sku`);
    expect(r.products.map((p) => p.sku).sort()).toEqual(rows.map((x) => x.sku));
    expect(r.products.every((p) => p.isLow && p.stock < p.minStock)).toBe(true);
    expect(r.total).toBe(rows.length);
  });

  it("ordena primero los más urgentes", async () => {
    const r = await getStockLevels(ctx.db);
    const gaps = r.products.map((p) => p.stock - p.minStock);
    const lowFirst = r.products.map((p) => p.isLow);
    expect(lowFirst).toEqual([...lowFirst].sort((a, b) => Number(b) - Number(a)));
    const lowGaps = gaps.filter((_, i) => lowFirst[i]);
    expect(lowGaps).toEqual([...lowGaps].sort((a, b) => a - b));
  });

  it("busca por nombre sin importar mayúsculas ni acentos, y por sku", async () => {
    const byName = await getStockLevels(ctx.db, { query: "LOCION" });
    expect(byName.products.map((p) => p.name)).toEqual(["Loción after shave"]);
    const bySku = await getStockLevels(ctx.db, { query: "cer-00" });
    expect(bySku.products.map((p) => p.sku).sort()).toEqual(["CER-001", "CER-002"]);
  });

  it("recorta con el total real y marca truncated", async () => {
    const r = await getStockLevels(ctx.db, {}, { limit: 4 });
    expect(r.products).toHaveLength(4);
    expect(r.total).toBe(15);
    expect(r.truncated).toBe(true);
  });

  it("un texto con forma de SQL no encuentra nada ni toca la base", async () => {
    const r = await getStockLevels(ctx.db, { query: "'; DELETE FROM products;--" });
    expect(r.total).toBe(0);
    expect((await ctx.sql.query(`SELECT COUNT(*)::int AS n FROM products`)).rows[0].n).toBe(15);
  });
});

describe("getStockLevelsInput", () => {
  it("acepta vacío y rechaza parámetros desconocidos o tipos incorrectos", () => {
    expect(getStockLevelsInput.safeParse({}).success).toBe(true);
    expect(getStockLevelsInput.safeParse({ onlyLow: "si" }).success).toBe(false);
    expect(getStockLevelsInput.safeParse({ orderBy: "stock" }).success).toBe(false);
  });
});
