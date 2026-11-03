import { describe, expect, it } from "vitest";
import {
  caseMessages,
  checkCriteria,
  evaluateClarifications,
  evaluateRouter,
  formatReport,
  type CaseResult,
} from "../evals/router.js";
import { ROUTER_CASES } from "../evals/router-cases.js";
import type { Intent } from "../src/graph/intents.js";
import type { AgentModel } from "../src/graph/nodes/agent.js";
import type { RouterModel } from "../src/graph/nodes/router.js";
import { routed } from "./helpers/graph.js";
import { AIMessage } from "@langchain/core/messages";

/** Resultados sintéticos: aciertan todos salvo los ids indicados, que devuelven otra intención. */
function results(failing: string[] = []): CaseResult[] {
  return ROUTER_CASES.map((c) => {
    const wrong = failing.includes(c.id);
    const actual = wrong ? (c.expected === "chat" ? "query" : "chat") : c.expected;
    return { case: c, actual, reason: "motivo", ok: !wrong };
  });
}
const question = (isQuestion: boolean, i: number) => ({ caseId: `B-${i}`, question: "x", isQuestion });

describe("checkCriteria", () => {
  it("cumple cuando todo acierta", () => {
    expect(checkCriteria(results()).pass).toBe(true);
  });

  it("A: acepta 2 errores (18/20) y rechaza 3", () => {
    expect(checkCriteria(results(["A-query-1", "A-chat-1"])).a).toMatchObject({ hits: 18, pass: true });
    expect(checkCriteria(results(["A-query-1", "A-chat-1", "A-report-1"])).a).toMatchObject({ hits: 17, pass: false });
  });

  it("B: acepta 1 error (5/6) y rechaza 2", () => {
    expect(checkCriteria(results(["B-1"])).b.pass).toBe(true);
    expect(checkCriteria(results(["B-1", "B-2"])).b.pass).toBe(false);
  });

  it("B: además exige que al menos 5 de 6 aclaraciones terminen en '?'", () => {
    const ok = [1, 2, 3, 4, 5, 6].map((i) => question(i !== 6, i)); // 5 de 6
    const bad = [1, 2, 3, 4, 5, 6].map((i) => question(i <= 4, i)); // 4 de 6
    expect(checkCriteria(results(), ok).b).toMatchObject({ pass: true, questions: { hits: 5, total: 6 } });
    expect(checkCriteria(results(), bad).b.pass).toBe(false);
  });

  it("C: acepta 1 error (3/4) pero C-3 nunca puede fallar", () => {
    expect(checkCriteria(results(["C-1"])).c.pass).toBe(true);
    const c3 = checkCriteria(results(["C-3"])).c;
    expect(c3.hits).toBe(3);
    expect(c3.securityCasePasses).toBe(false);
    expect(c3.pass).toBe(false);
  });

  it("el resultado global exige los tres conjuntos", () => {
    expect(checkCriteria(results(["B-1", "B-2"])).pass).toBe(false);
  });
});

describe("formatReport", () => {
  it("muestra aciertos por categoría, matriz de confusión y errores", () => {
    const report = formatReport(results(["A-query-1"]));
    expect(report).toContain("Aciertos por categoría esperada");
    expect(report).toMatch(/query\s+5\/6/);
    expect(report).toContain("Matriz de confusión");
    expect(report).toContain("A-query-1");
    expect(report).toMatch(/esperado query, obtenido chat/);
    expect(report).toContain("CUMPLE");
  });

  it("sin errores no lista errores", () => {
    expect(formatReport(results())).not.toContain("Errores:");
  });
});

describe("evaluateRouter y evaluateClarifications", () => {
  it("corre cada caso por el nodo router y marca los aciertos", async () => {
    // Router falso que acierta siempre porque conoce el caso por su mensaje.
    const byMessage = new Map(ROUTER_CASES.map((c) => [c.message, c.expected]));
    const seen: string[] = [];
    const model: RouterModel = {
      async invoke(messages) {
        const text = messages[1]!.text;
        const last = [...byMessage.keys()].find((m) => text.trimEnd().endsWith(`${m}\n\nClasificá el último mensaje de la persona.`));
        seen.push(last ?? "?");
        return { parsed: routed((last ? byMessage.get(last) : "chat") as Intent, "ok") };
      },
    };
    const out = await evaluateRouter(model);
    expect(out).toHaveLength(30);
    expect(out.every((r) => r.ok)).toBe(true);
    expect(seen).not.toContain("?");
  });

  it("un router que devuelve salida inválida cuenta como 'invalid'", async () => {
    const model: RouterModel = { async invoke() { return { parsed: null }; } };
    const out = await evaluateRouter(model, ROUTER_CASES.slice(0, 2));
    expect(out.map((r) => r.actual)).toEqual(["invalid", "invalid"]);
    expect(out.every((r) => !r.ok)).toBe(true);
  });

  it("las aclaraciones solo se piden para el conjunto B y se miden por el '?' final", async () => {
    let n = 0;
    const model: AgentModel = {
      async invoke() { return new AIMessage(n++ % 2 === 0 ? "¿Qué turno?" : "¿Qué turno? (por ejemplo, el de hoy)"); },
    };
    const out = await evaluateClarifications(model);
    expect(out.map((q) => q.caseId)).toEqual(["B-1", "B-2", "B-3", "B-4", "B-5", "B-6"]);
    expect(out.map((q) => q.isQuestion)).toEqual([true, false, true, false, true, false]);
  });

  it("caseMessages arma el historial y termina con el mensaje nuevo", () => {
    const c3 = ROUTER_CASES.find((c) => c.id === "C-3")!;
    const messages = caseMessages(c3);
    expect(messages.map((m) => m.type)).toEqual(["human", "ai", "human"]);
    expect(messages.at(-1)?.text).toBe("Ok, gracias.");
  });
});
