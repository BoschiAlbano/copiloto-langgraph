import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Db } from "../../src/db/client.js";
import { makeReadTools } from "../../src/tools/index.js";

// Las herramientas solo guardan la referencia al cliente: para inspeccionarlas alcanza uno falso.
const tools = makeReadTools({} as Db);

describe("herramientas del agente", () => {
  it("son exactamente las cuatro de lectura", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(["findClient", "getSalesSummary", "getStockLevels", "listAppointments"]);
  });

  it("ninguna acepta SQL ni consultas libres", () => {
    for (const t of tools) {
      const schema = z.toJSONSchema(t.schema as z.ZodType) as { properties?: Record<string, unknown> };
      const names = Object.keys(schema.properties ?? {});
      expect(names.filter((n) => /sql|statement|command|raw|where/i.test(n)), t.name).toEqual([]);
    }
  });

  it("todas rechazan parámetros desconocidos (esquema estricto)", () => {
    for (const t of tools) {
      const schema = z.toJSONSchema(t.schema as z.ZodType) as { additionalProperties?: unknown };
      expect(schema.additionalProperties, t.name).toBe(false);
    }
  });

  it("todas tienen una descripción útil para el modelo", () => {
    for (const t of tools) expect(t.description.length, t.name).toBeGreaterThan(60);
  });
});
