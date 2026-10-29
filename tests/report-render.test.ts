import { describe, expect, it } from "vitest";
import { renderReport, sectionStatus } from "../src/graph/report/render.js";
import type { AppointmentsData, ReportPart, SalesData, StockData } from "../src/graph/report/state.js";

const report = { id: "r1", label: "semana del 26/10 al 01/11" };

const sales: SalesData = {
  salesCount: 38,
  totalRevenue: 312_400,
  averageTicket: 8_221,
  byPaymentMethod: [
    { method: "cash", count: 20, total: 150_000 },
    { method: "card", count: 12, total: 100_400 },
    { method: "transfer", count: 6, total: 62_000 },
  ],
  byItemType: { products: { units: 31, revenue: 112_400 }, services: { units: 25, revenue: 200_000 } },
};
const appointments: AppointmentsData = { total: 120, activeCount: 112, countByStatus: { scheduled: 85, done: 20, cancelled: 8, no_show: 7 } };
const stock: StockData = {
  total: 15,
  lowCount: 2,
  low: [
    { name: "Pomada clásica", sku: "POM-001", stock: 3, minStock: 5 },
    { name: "Gel fijación fuerte", sku: "GEL-001", stock: 6, minStock: 8 },
  ],
};

const ok = (section: ReportPart["section"], data: unknown, reportId = "r1"): ReportPart => ({ reportId, section, status: "ok", data });
const failed = (section: ReportPart["section"], error: string): ReportPart => ({ reportId: "r1", section, status: "error", error });
const all = [ok("sales", sales), ok("appointments", appointments), ok("stock", stock)];

describe("renderReport", () => {
  it("CA2 (sin base): incluye las tres secciones con todas sus cifras", () => {
    const text = renderReport(report, all);
    expect(text).toBe(
      [
        "Reporte · semana del 26/10 al 01/11",
        "",
        "Ventas",
        "• 38 ventas por $ 312.400 · ticket promedio $ 8.221",
        "• Por medio de pago: efectivo $ 150.000 (20) · tarjeta $ 100.400 (12) · transferencia $ 62.000 (6)",
        "• Servicios: $ 200.000 (25 unidades) · Productos: $ 112.400 (31 unidades)",
        "",
        "Turnos",
        "• 120 turnos en el período, 112 activos (sin contar cancelados)",
        "• Por estado: agendados 85 · realizados 20 · cancelados 8 · ausentes 7",
        "",
        "Stock",
        "• 2 productos están por debajo del mínimo, de 15 productos en total (stock de hoy):",
        "  - Pomada clásica (POM-001): 3 de 5",
        "  - Gel fijación fuerte (GEL-001): 6 de 8",
      ].join("\n"),
    );
  });

  it("es una función pura: los mismos datos dan el mismo texto, sin importar el orden de las partes", () => {
    expect(renderReport(report, [...all].reverse())).toBe(renderReport(report, all));
  });

  it("incluye el aviso cuando lo hay", () => {
    const text = renderReport({ ...report, notice: "No pude interpretar el período; muestro la semana actual." }, all);
    expect(text.split("\n")[1]).toBe("⚠ No pude interpretar el período; muestro la semana actual.");
  });

  it("CA3: una sección que falló dice cuál falta y las otras salen completas", () => {
    for (const section of ["sales", "appointments", "stock"] as const) {
      const parts = all.map((p) => (p.section === section ? failed(section, "problema del sistema (código P1000)") : p));
      const text = renderReport(report, parts);
      expect(text, section).toContain("• No disponible: problema del sistema (código P1000).");
      expect(text.match(/No disponible/g), section).toHaveLength(1);
      expect(text, section).not.toContain("ninguna de las tres");
      // Las otras dos secciones siguen completas.
      if (section !== "sales") expect(text).toContain("38 ventas por $ 312.400");
      if (section !== "appointments") expect(text).toContain("120 turnos en el período");
      if (section !== "stock") expect(text).toContain("Pomada clásica (POM-001): 3 de 5");
    }
  });

  it("CA8: el motivo de un límite aparece tal cual", () => {
    const text = renderReport(report, [ok("sales", sales), failed("appointments", "El rango no puede superar 31 días"), ok("stock", stock)]);
    expect(text).toContain("• No disponible: El rango no puede superar 31 días.");
    expect(text).toContain("38 ventas");
  });

  it("si fallan las tres lo dice y no falla", () => {
    const text = renderReport(report, [failed("sales", "a"), failed("appointments", "b"), failed("stock", "c")]);
    expect(text).toContain("No se pudo armar ninguna de las tres secciones.");
    expect(text.match(/No disponible/g)).toHaveLength(3);
  });

  it("una sección que nunca llegó se informa como no disponible", () => {
    const text = renderReport(report, [ok("sales", sales)]);
    expect(text.match(/No disponible: no se recibió el resultado de esta sección\./g)).toHaveLength(2);
  });

  it("ignora las partes de otro reporte que hubiera en el estado", () => {
    const stale = [ok("sales", { ...sales, salesCount: 999 }, "otro"), ...all];
    expect(renderReport(report, stale)).not.toContain("999");
    expect(renderReport(report, [ok("sales", sales, "otro")])).toContain("No disponible");
  });

  it("períodos sin movimiento y singulares", () => {
    const empty = renderReport(report, [
      ok("sales", { ...sales, salesCount: 0, totalRevenue: 0, averageTicket: 0, byPaymentMethod: [] }),
      ok("appointments", { total: 0, activeCount: 0, countByStatus: {} }),
      ok("stock", { total: 15, lowCount: 0, low: [] }),
    ]);
    expect(empty).toContain("• No hubo ventas en el período.");
    expect(empty).toContain("• No hay turnos en el período.");
    expect(empty).toContain("• Ningún producto está por debajo del mínimo (15 productos en total).");

    const one = renderReport(report, [
      ok("sales", { ...sales, salesCount: 1, totalRevenue: 8_000, averageTicket: 8_000, byPaymentMethod: [{ method: "cash", count: 1, total: 8_000 }], byItemType: { products: { units: 0, revenue: 0 }, services: { units: 1, revenue: 8_000 } } }),
      ok("appointments", { total: 1, activeCount: 1, countByStatus: { scheduled: 1 } }),
      ok("stock", { total: 1, lowCount: 1, low: [{ name: "Cera mate", sku: "CER-001", stock: 0, minStock: 6 }] }),
    ]);
    expect(one).toContain("• 1 venta por $ 8.000");
    expect(one).toContain("(1 unidad)");
    expect(one).toContain("• 1 turno en el período");
    expect(one).toContain("• 1 producto está por debajo del mínimo, de 1 producto en total");
  });

  it("la lista de stock bajo se acota y dice cuántos más hay", () => {
    const low = Array.from({ length: 14 }, (_, i) => ({ name: `Producto ${i + 1}`, sku: `P-${i + 1}`, stock: 0, minStock: 3 }));
    const text = renderReport(report, [ok("sales", sales), ok("appointments", appointments), ok("stock", { total: 20, lowCount: 14, low })]);
    expect(text.match(/^ {2}- Producto/gm)).toHaveLength(10);
    expect(text).toContain("  - y 4 más");
  });

  it("estados desconocidos de los turnos se muestran en vez de perderse", () => {
    const text = renderReport(report, [ok("sales", sales), ok("appointments", { total: 3, activeCount: 3, countByStatus: { scheduled: 2, pausado: 1 } }), ok("stock", stock)]);
    expect(text).toContain("Por estado: agendados 2 · pausado 1");
  });
});

describe("sectionStatus", () => {
  it("resume el estado de cada sección", () => {
    expect(sectionStatus(report, [ok("sales", sales), failed("appointments", "x")])).toEqual({ sales: "ok", appointments: "error", stock: "missing" });
  });
});
