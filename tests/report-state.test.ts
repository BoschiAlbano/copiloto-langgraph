import { describe, expect, it } from "vitest";
import { mergeParts, type ReportPart, type Section } from "../src/graph/report/state.js";

const part = (reportId: string, section: Section, extra: Partial<ReportPart> = {}): ReportPart => ({ reportId, section, status: "ok", data: { section }, ...extra });

describe("mergeParts (reducer de reportParts)", () => {
  it("CA4: las tres partes de un mismo reporte se juntan sin perderse, en cualquier orden de llegada", () => {
    const parts = [part("r1", "sales"), part("r1", "appointments"), part("r1", "stock")];
    const orders = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
      [1, 2, 0],
    ];
    for (const order of orders) {
      // Cada escritura llega por separado, como cuando tres nodos escriben en el mismo paso.
      const merged = order.reduce<ReportPart[]>((acc, i) => mergeParts(acc, [parts[i]!]), []);
      expect(merged.map((p) => p.section).sort(), order.join()).toEqual(["appointments", "sales", "stock"]);
    }
  });

  it("también las junta cuando llegan todas en una sola escritura", () => {
    expect(mergeParts([], [part("r1", "sales"), part("r1", "stock")])).toHaveLength(2);
  });

  it("un reporte nuevo en el mismo hilo reemplaza las partes del anterior", () => {
    const first = [part("r1", "sales"), part("r1", "appointments"), part("r1", "stock")];
    const afterSecond = mergeParts(mergeParts(first, [part("r2", "sales")]), [part("r2", "stock")]);
    expect(afterSecond.map((p) => `${p.reportId}:${p.section}`)).toEqual(["r2:sales", "r2:stock"]);
  });

  it("una sección repetida del mismo reporte (un reintento) reemplaza a la anterior", () => {
    const failed = part("r1", "sales", { status: "error", data: undefined, error: "problema del sistema" });
    const retried = part("r1", "sales");
    const merged = mergeParts([failed, part("r1", "stock")], [retried]);
    expect(merged).toHaveLength(2);
    expect(merged.find((p) => p.section === "sales")?.status).toBe("ok");
  });

  it("una escritura vacía no cambia nada, y no modifica los arreglos recibidos", () => {
    const left = [part("r1", "sales")];
    const copy = structuredClone(left);
    expect(mergeParts(left, [])).toBe(left);
    mergeParts(left, [part("r1", "stock")]);
    expect(left).toEqual(copy);
  });
});
