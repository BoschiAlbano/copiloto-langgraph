import { routerOutputSchema } from "../src/graph/intents.js";
import { readFileSync } from "node:fs";
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { checkPlanCriteria, evaluatePlans, formatPlanReport } from "../evals/plan.js";
import { PLAN_CASES } from "../evals/plan-cases.js";
import type { RouterModel } from "../src/graph/nodes/router.js";
import { planned } from "./helpers/graph.js";

// El corredor de los escenarios M1 a M8 con un router falso (sin API). Con el modelo real: tests/plan.llm.test.ts.

/** Router falso que conoce la respuesta de cada escenario, salvo los que se le indique. */
function oracle(wrong: string[] = []): RouterModel {
  return {
    async invoke(messages) {
      const text = (messages[1] as HumanMessage).text;
      const c = PLAN_CASES.find((x) => text.includes(x.message))!;
      if (wrong.includes(c.id)) return { parsed: planned(["chat", "x"]) };
      return { parsed: planned(...c.expected.map((intent, i) => [intent, `parte ${i + 1}`] as [typeof intent, string])) };
    },
  };
}

describe("evaluatePlans y checkPlanCriteria", () => {
  it("compara el plan normalizado con lo esperado", async () => {
    const results = await evaluatePlans(oracle());
    expect(results).toHaveLength(8);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(checkPlanCriteria(results)).toEqual({ hits: 8, total: 8, criticalPass: true, pass: true });
  });

  it("7 de 8 cumple si el que falla no es crítico; un crítico que falla no cumple", async () => {
    expect(checkPlanCriteria(await evaluatePlans(oracle(["M3"]))).pass).toBe(true);
    expect(checkPlanCriteria(await evaluatePlans(oracle(["M3", "M4"]))).pass).toBe(false);
    expect(checkPlanCriteria(await evaluatePlans(oracle(["M1"]))).pass).toBe(false);
  });

  it("una salida inválida cuenta como error aunque el respaldo sea una consulta", async () => {
    const invalid: RouterModel = { async invoke() { return { parsed: null }; } };
    const results = await evaluatePlans(invalid, PLAN_CASES.filter((c) => c.id === "M4"));
    expect(results[0]).toMatchObject({ ok: false, fallback: true, observed: ["query"] });
  });

  it("el informe muestra lo esperado, lo que salió y las partes", async () => {
    const report = formatPlanReport(await evaluatePlans(oracle(["M3"])));
    expect(report).toContain("✖ M3");
    expect(report).toContain("esperado: action → query · salió: action → query");
    expect(report).toContain("Aciertos: 7/8");
    expect(report).toContain("CUMPLE");
  });
});

describe("prompt del router (fase 7)", () => {
  const prompt = readFileSync(new URL("../src/graph/prompts/router.md", import.meta.url), "utf8");
  const normalize = (s: string) => s.toLowerCase().replace(/[¿?¡!.,"«»]/g, "").replace(/\s+/g, " ").trim();

  it("CA6: ninguna frase de los escenarios M1 a M8 aparece en el prompt", () => {
    const haystack = normalize(prompt);
    for (const c of PLAN_CASES) expect(haystack.includes(normalize(c.message)), `${c.id}: "${c.message}"`).toBe(false);
  });

  it("dice cuándo separar en tareas y pide el formato nuevo", () => {
    // Fase 11: la sección «Cuándo separar en tareas» se sacó porque la comparación con el set completo no mostró
    // ningún cambio sin ella (ver la spec de la fase 11). Lo dicen la primera línea del prompt y el esquema de salida.
    expect(prompt).toMatch(/si pide varias cosas de distinto tipo, separarlas en tareas/);
    expect(routerOutputSchema.shape.tasks.description).toMatch(/Casi siempre es una sola/);
    expect(prompt).toMatch(/`tasks` \(de 1 a 3 tareas/);
    expect(prompt).not.toMatch(/Si el pedido mezcla un cambio con una consulta, es action/);
  });
});
