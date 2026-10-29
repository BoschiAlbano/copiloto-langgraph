import { describe, expect, it } from "vitest";
import { ACTION_DEFINITIONS } from "../src/tools/actions/definitions.js";
import { ACTION_NAMES, ACTION_SCHEMAS, isActionName } from "../src/tools/actions/schemas.js";
import { makeReadTools } from "../src/tools/index.js";

const valid = {
  createAppointment: { clientId: 1, staffName: "Lucas", serviceName: "Corte", date: "2026-11-23", time: "15:00" },
  cancelAppointment: { appointmentId: 7, reason: "Lo pidió el cliente" },
  registerSale: { clientId: 3, paymentMethod: "cash", items: [{ sku: "CER-001", qty: 2 }, { serviceName: "Corte", qty: 1 }] },
  adjustStock: { sku: "SHA-001", delta: 20, reason: "Llegó un pedido" },
} as const;

describe("esquemas de las acciones", () => {
  it("son exactamente las cuatro del plan", () => {
    expect([...ACTION_NAMES].sort()).toEqual(["adjustStock", "cancelAppointment", "createAppointment", "registerSale"]);
    expect(isActionName("createAppointment")).toBe(true);
    for (const other of ["findClient", "toString", "constructor", "__proto__", "deleteEverything"]) {
      expect(isActionName(other), other).toBe(false);
    }
  });

  it("aceptan los parámetros válidos", () => {
    for (const name of ACTION_NAMES) expect(ACTION_SCHEMAS[name].safeParse(valid[name]).success, name).toBe(true);
  });

  it("rechazan campos de más (el modelo no puede colar precios, totales ni estados)", () => {
    const extras: Record<string, Record<string, unknown>> = {
      createAppointment: { status: "done" },
      cancelAppointment: { status: "done" },
      registerSale: { total: 1 },
      adjustStock: { newStock: 999 },
    };
    for (const name of ACTION_NAMES) {
      const result = ACTION_SCHEMAS[name].safeParse({ ...valid[name], ...extras[name] });
      expect(result.success, name).toBe(false);
    }
    expect(ACTION_SCHEMAS.registerSale.safeParse({ ...valid.registerSale, items: [{ sku: "CER-001", qty: 1, unitPrice: 1 }] }).success).toBe(false);
  });

  it("rechazan valores fuera de los límites", () => {
    const cases: [keyof typeof ACTION_SCHEMAS, unknown][] = [
      ["createAppointment", { ...valid.createAppointment, clientId: 0 }],
      ["createAppointment", { ...valid.createAppointment, time: "25:00" }],
      ["createAppointment", { ...valid.createAppointment, time: "9:00" }],
      ["createAppointment", { ...valid.createAppointment, date: "2026-02-30" }],
      ["cancelAppointment", { appointmentId: -1 }],
      ["cancelAppointment", { appointmentId: 1.5 }],
      ["registerSale", { ...valid.registerSale, items: [] }],
      ["registerSale", { ...valid.registerSale, items: Array.from({ length: 11 }, () => ({ sku: "CER-001", qty: 1 })) }],
      ["registerSale", { ...valid.registerSale, items: [{ sku: "CER-001", qty: 0 }] }],
      ["registerSale", { ...valid.registerSale, items: [{ sku: "CER-001", qty: 51 }] }],
      ["registerSale", { ...valid.registerSale, paymentMethod: "bitcoin" }],
      ["registerSale", { ...valid.registerSale, items: [{ sku: "CER-001", serviceName: "Corte", qty: 1 }] }],
      ["adjustStock", { ...valid.adjustStock, delta: 0 }],
      ["adjustStock", { ...valid.adjustStock, delta: 501 }],
      ["adjustStock", { ...valid.adjustStock, delta: -501 }],
      ["adjustStock", { ...valid.adjustStock, delta: 1.5 }],
      ["adjustStock", { ...valid.adjustStock, reason: "ok" }],
      ["adjustStock", { ...valid.adjustStock, sku: "'; DROP TABLE products; --" }],
    ];
    for (const [name, input] of cases) {
      expect(ACTION_SCHEMAS[name].safeParse(input).success, `${name} ${JSON.stringify(input)}`).toBe(false);
    }
  });

  it("normalizan el SKU a mayúsculas", () => {
    expect(ACTION_SCHEMAS.adjustStock.parse({ ...valid.adjustStock, sku: " sha-001 " }).sku).toBe("SHA-001");
  });
});

describe("definiciones que ve el modelo", () => {
  it("son las cuatro acciones y ninguna se puede ejecutar como herramienta", async () => {
    expect(ACTION_DEFINITIONS.map((t) => t.name).sort()).toEqual([...ACTION_NAMES].sort());
    for (const definition of ACTION_DEFINITIONS) {
      await expect(definition.invoke(valid[definition.name as keyof typeof valid] as never)).rejects.toThrow(/necesita aprobación/);
    }
  });

  it("dejan claro en la descripción que son propuestas", () => {
    for (const definition of ACTION_DEFINITIONS) expect(definition.description).toMatch(/PROPONE/);
  });

  it("las herramientas de lectura del agente no incluyen ninguna acción", () => {
    const readNames = makeReadTools({} as never).map((t) => t.name);
    for (const name of ACTION_NAMES) expect(readNames).not.toContain(name);
  });
});
