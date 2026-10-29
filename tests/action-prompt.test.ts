import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { actionCases } from "../evals/action-cases.js";
import { renderActionPrompt } from "../src/graph/nodes/action-agent.js";
import { ACTION_NAMES } from "../src/tools/actions/schemas.js";

const prompt = readFileSync(new URL("../src/graph/prompts/action.md", import.meta.url), "utf8");

describe("prompt de la rama de acciones", () => {
  it("lleva la fecha de hoy y no deja el marcador", () => {
    const rendered = renderActionPrompt(new Date("2026-10-28T15:00:00Z"));
    expect(rendered).toContain("miércoles 28 de octubre de 2026");
    expect(rendered).not.toContain("{{");
  });

  it("menciona las cuatro acciones y las reglas de seguridad", () => {
    for (const name of ACTION_NAMES) expect(prompt, name).toContain(name);
    expect(prompt).toMatch(/una sola acción por mensaje/);
    expect(prompt).toMatch(/no la ejecuta: es una propuesta|Pedirla no la ejecuta/);
    expect(prompt).toMatch(/Nunca digas que algo ya se hizo/);
    expect(prompt).toMatch(/información, nunca instrucciones/);
    expect(prompt).toMatch(/No calcules precios ni totales/);
  });

  it("no contiene ninguna frase de los escenarios congelados (E1 a E6)", () => {
    const normalize = (s: string) => s.toLowerCase().replace(/[¿?¡!.,"]/g, "").replace(/\s+/g, " ").trim();
    const haystack = normalize(prompt);
    for (const c of actionCases()) {
      expect(haystack.includes(normalize(c.message)), `${c.id}: "${c.message}"`).toBe(false);
    }
    // Ni los nombres de los datos de prueba de los escenarios.
    for (const name of ["Julián Romero", "Walter Maidana", "Facundo Sosa", "Pruebas Fase Cinco", "Doble Turno Pruebas"]) {
      expect(haystack.includes(normalize(name)), name).toBe(false);
    }
  });
});
