import { describe, expect, it } from "vitest";
import { generateSeed } from "../src/db/seed-generator.js";

const NOW = new Date("2026-10-27T15:00:00Z");
const data = generateSeed(NOW);

describe("generateSeed", () => {
  it("es determinístico: misma fecha y semilla dan los mismos datos", () => {
    expect(generateSeed(NOW)).toEqual(data);
  });

  it("genera las cantidades fijas del plan", () => {
    expect(data.clients).toHaveLength(30);
    expect(data.staff).toHaveLength(3);
    expect(data.services).toHaveLength(4);
    expect(data.products).toHaveLength(15);
  });

  it("no superpone turnos del mismo barbero", () => {
    for (const barber of data.staff) {
      const mine = data.appointments
        .filter((a) => a.staffId === barber.id && a.status !== "cancelled")
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      for (let i = 1; i < mine.length; i++) {
        expect(mine[i]!.startsAt.getTime()).toBeGreaterThanOrEqual(mine[i - 1]!.endsAt.getTime());
      }
    }
  });

  it("no agenda turnos los domingos (hora de Argentina)", () => {
    for (const a of data.appointments) {
      const localDay = new Date(a.startsAt.getTime() - 3 * 3_600_000).getUTCDay();
      expect(localDay).not.toBe(0);
    }
  });

  it("deja turnos futuros agendados y pasados cerrados", () => {
    for (const a of data.appointments) {
      if (a.endsAt <= NOW) expect(a.status).not.toBe("scheduled");
      else expect(["scheduled", "cancelled"]).toContain(a.status);
    }
    expect(data.appointments.some((a) => a.startsAt > NOW && a.status === "scheduled")).toBe(true);
  });

  it("cada venta suma lo mismo que sus renglones", () => {
    const sums = new Map<number, number>();
    for (const item of data.saleItems) {
      sums.set(item.saleId, (sums.get(item.saleId) ?? 0) + item.qty * item.unitPrice);
    }
    for (const sale of data.sales) expect(sale.total).toBe(sums.get(sale.id));
  });

  it("cada renglón es de un producto o de un servicio, nunca de ambos", () => {
    for (const item of data.saleItems) {
      expect((item.productId === null) !== (item.serviceId === null)).toBe(true);
    }
  });

  it("deja stock no negativo y algunos productos bajo el mínimo", () => {
    expect(data.products.every((p) => p.stock >= 0)).toBe(true);
    expect(data.products.filter((p) => p.stock < p.minStock).length).toBeGreaterThanOrEqual(1);
  });
});
