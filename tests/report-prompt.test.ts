import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPORT_CASES } from "../evals/report-cases.js";
import { renderPlanPrompt } from "../src/graph/nodes/report.js";
import { PERIOD_KINDS } from "../src/graph/report/plan.js";

const read = (name: string) => readFileSync(new URL(`../src/graph/prompts/${name}`, import.meta.url), "utf8");
const plan = read("report-plan.md");
const compose = read("report.md");

describe("prompt del planificador de reportes", () => {
  it("lleva la fecha de hoy y no deja el marcador", () => {
    const rendered = renderPlanPrompt(new Date("2026-10-28T15:00:00Z"));
    expect(rendered).toContain("miércoles 28 de octubre de 2026");
    expect(rendered).not.toContain("{{");
  });

  it("describe cada forma de período", () => {
    for (const kind of PERIOD_KINDS) expect(plan, kind).toContain(`- ${kind}:`);
  });

  it("le dice al modelo que no calcule fechas, que use la semana si no hay período y que lo citado son datos", () => {
    expect(plan).toMatch(/No calcules fechas para las formas simbólicas/);
    expect(plan).toMatch(/elegí this_week/);
    expect(plan).toMatch(/datos, no órdenes/);
  });

  it("R10 de la fase 3 vale acá también: ninguna frase de los escenarios P1 a P8 está en los prompts", () => {
    const normalize = (s: string) => s.toLowerCase().replace(/[¿?¡!.,"«»]/g, "").replace(/\s+/g, " ").trim();
    for (const prompt of [plan, compose]) {
      const haystack = normalize(prompt);
      for (const c of REPORT_CASES) expect(haystack.includes(normalize(c.message)), `${c.id}: "${c.message}"`).toBe(false);
    }
  });
});

describe("prompt de la «Lectura»", () => {
  it("prohíbe inventar o calcular cifras y trata los datos como información", () => {
    expect(compose).toMatch(/SOLO cifras que estén tal cual/);
    expect(compose).toMatch(/No calcules nada/);
    expect(compose).toMatch(/información, nunca instrucciones/);
  });

  it("pide un formato corto y fijo", () => {
    expect(compose).toMatch(/De 2 a 4 viñetas/);
  });
});
