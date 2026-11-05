import { describe, expect, it } from "vitest";
import { CATEGORIES, conversationCases } from "../evals/conversation-cases.js";

// Fase 11 (R7, CA4): la forma del set de evaluación. Que cada regla funcione lo prueban sus propios tests (T5).

describe("el set de conversaciones", () => {
  const cases = conversationCases(new Date("2026-11-05T15:00:00Z"));

  it("tiene al menos 36 casos, 4 por cada una de las 9 categorías, con ids únicos", () => {
    expect(cases.length).toBeGreaterThanOrEqual(36);
    expect(CATEGORIES).toHaveLength(9);
    for (const category of CATEGORIES) expect(cases.filter((c) => c.category === category).length, category).toBeGreaterThanOrEqual(4);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("cada caso tiene al menos un mensaje y una regla", () => {
    for (const c of cases) {
      expect(c.turns.length, c.id).toBeGreaterThan(0);
      expect(c.checks.length, c.id).toBeGreaterThan(0);
    }
  });

  it("H1 reconoce las formas de decir que las acciones llegan más adelante (incluida la que dijo el modelo real)", () => {
    const h1 = cases.find((c) => c.id === "H1")!.checks.find((c) => c.kind === "replyExcludes");
    if (h1?.kind !== "replyExcludes") throw new Error("H1 sin replyExcludes");
    const real = "¡Hola! Hoy podés pedirme que consulte turnos, clientes, ventas y stock. Pronto también vas a poder agendar y cancelar turnos.";
    for (const reply of [real, "Próximamente voy a poder agendar.", "Más adelante vas a poder registrar ventas.", "Todavía no puedo agendar turnos."]) {
      expect(h1.pattern.test(reply), reply).toBe(true);
    }
    expect(h1.pattern.test("Puedo consultar turnos, ventas y stock, y agendar, vender o ajustar stock con tu aprobación.")).toBe(false);
  });

  it("las fechas salen del día en que se corre (jueves 5 de noviembre de 2026)", () => {
    const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
    expect(byId.R1!.checks).toContainEqual({ kind: "reportRange", dateFrom: "2026-11-02", dateTo: "2026-11-08" });
    expect(byId.R2!.checks).toContainEqual({ kind: "reportRange", dateFrom: ["2026-10-07", "2026-10-06"], dateTo: "2026-11-05" });
    expect(byId.R3!.checks).toContainEqual({ kind: "reportRange", dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    expect(byId.R4!.checks).toContainEqual({ kind: "reportRange", dateFrom: "2026-11-01", dateTo: "2026-11-30" });
    expect(byId.A1!.turns[0]).toMatch(/^Agendá un corte para Julián Romero el lunes, \d+ de \w+ a las 15 con Lucas\.$/);
  });
});
