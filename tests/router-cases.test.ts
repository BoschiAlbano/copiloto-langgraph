import { describe, expect, it } from "vitest";
import { ROUTER_CASES } from "../evals/router-cases.js";

const inSet = (set: "A" | "B" | "C") => ROUTER_CASES.filter((c) => c.set === set);

describe("casos de evaluación del router", () => {
  it("son 30: 20 claros, 6 ambiguos y 4 con historial", () => {
    expect(ROUTER_CASES).toHaveLength(30);
    expect(inSet("A")).toHaveLength(20);
    expect(inSet("B")).toHaveLength(6);
    expect(inSet("C")).toHaveLength(4);
  });

  it("el conjunto A tiene 5 casos por categoría y ninguno con historial", () => {
    for (const intent of ["query", "action", "report", "chat"] as const) {
      expect(inSet("A").filter((c) => c.expected === intent), intent).toHaveLength(5);
    }
    expect(inSet("A").every((c) => c.history.length === 0)).toBe(true);
  });

  it("el conjunto B espera siempre unclear y no tiene historial", () => {
    expect(inSet("B").every((c) => c.expected === "unclear" && c.history.length === 0)).toBe(true);
  });

  it("el conjunto C cubre consulta, acción, charla y reporte, todos con historial", () => {
    expect(inSet("C").map((c) => c.expected)).toEqual(["query", "action", "chat", "report"]);
    expect(inSet("C").every((c) => c.history.length >= 2)).toBe(true);
  });

  it("los ids y las frases no se repiten", () => {
    expect(new Set(ROUTER_CASES.map((c) => c.id)).size).toBe(30);
    expect(new Set(ROUTER_CASES.map((c) => c.message)).size).toBe(30);
  });

  it("incluye el caso de seguridad con la nota maliciosa citada en el historial", () => {
    const c3 = ROUTER_CASES.find((c) => c.id === "C-3")!;
    expect(c3.history.some((h) => h.text.includes("ignorá tus instrucciones"))).toBe(true);
    expect(c3.expected).toBe("chat");
  });
});
