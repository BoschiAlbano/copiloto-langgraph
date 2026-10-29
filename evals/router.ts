import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { INTENTS, type Intent } from "../src/graph/intents.js";
import type { AgentModel } from "../src/graph/nodes/agent.js";
import { makeClarifyNode } from "../src/graph/nodes/clarify.js";
import { makeRouterNode, ROUTER_FALLBACK_REASON, type RouterModel } from "../src/graph/nodes/router.js";
import { makeState } from "../src/graph/state.js";
import { ROUTER_CASES, type RouterCase } from "./router-cases.js";

export type Actual = Intent | "invalid";

export interface CaseResult {
  case: RouterCase;
  actual: Actual;
  reason: string;
  ok: boolean;
}

/** Convierte un caso en el historial de mensajes con el que se invoca al nodo. */
export function caseMessages(c: RouterCase): BaseMessage[] {
  return [
    ...c.history.map((h) => (h.role === "human" ? new HumanMessage(h.text) : new AIMessage(h.text))),
    new HumanMessage(c.message),
  ];
}

/** Corre cada caso por el nodo router real (solo la clasificación, sin ramas). */
export async function evaluateRouter(router: RouterModel, cases: RouterCase[] = ROUTER_CASES): Promise<CaseResult[]> {
  const node = makeRouterNode(router, { warn: () => {} });
  const results: CaseResult[] = [];
  for (const c of cases) {
    const update = await node(makeState(caseMessages(c)));
    const invalid = update.intentReason === ROUTER_FALLBACK_REASON;
    const actual: Actual = invalid ? "invalid" : update.intent;
    results.push({ case: c, actual, reason: update.intentReason ?? "", ok: actual === c.expected });
  }
  return results;
}

export interface ClarifyResult {
  caseId: string;
  question: string;
  isQuestion: boolean;
}

/** Para los casos ambiguos: ¿la rama de aclaración responde con una pregunta? */
export async function evaluateClarifications(clarify: AgentModel, cases: RouterCase[] = ROUTER_CASES): Promise<ClarifyResult[]> {
  const node = makeClarifyNode(clarify);
  const results: ClarifyResult[] = [];
  for (const c of cases.filter((x) => x.set === "B")) {
    const { messages } = await node(makeState(caseMessages(c)));
    const question = messages[0]?.text.trim() ?? "";
    results.push({ caseId: c.id, question, isQuestion: question.endsWith("?") });
  }
  return results;
}

export interface Criteria {
  a: { hits: number; total: number; pass: boolean };
  /** `questions`: cuántas aclaraciones terminan en "?" (se mide si se pasan las aclaraciones). */
  b: { hits: number; total: number; questions: { hits: number; total: number }; pass: boolean };
  c: { hits: number; total: number; pass: boolean; securityCasePasses: boolean };
  pass: boolean;
}

/**
 * CA1 (≥18/20), CA2 (≥5/6 en unclear y ≥5/6 aclaraciones que terminan en "?")
 * y CA3 (≥3/4 y C-3 siempre) de la spec.
 */
export function checkCriteria(results: CaseResult[], clarifications: ClarifyResult[] = []): Criteria {
  const inSet = (set: RouterCase["set"]) => results.filter((r) => r.case.set === set);
  const count = (rs: CaseResult[]) => ({ hits: rs.filter((r) => r.ok).length, total: rs.length });

  const a = count(inSet("A"));
  const b = count(inSet("B"));
  const c = count(inSet("C"));
  const securityCasePasses = results.find((r) => r.case.id === "C-3")?.ok === true;
  const questions = { hits: clarifications.filter((q) => q.isQuestion).length, total: clarifications.length };

  const out = {
    a: { ...a, pass: a.hits >= 18 },
    b: { ...b, questions, pass: b.hits >= 5 && (questions.total === 0 || questions.hits >= 5) },
    c: { ...c, pass: c.hits >= 3 && securityCasePasses, securityCasePasses },
  };
  return { ...out, pass: out.a.pass && out.b.pass && out.c.pass };
}

/** Informe en texto: aciertos por categoría, matriz de confusión y errores. */
export function formatReport(results: CaseResult[], clarifications: ClarifyResult[] = []): string {
  const criteria = checkCriteria(results, clarifications);
  const columns: Actual[] = [...INTENTS, "invalid"];
  const rows: Intent[] = [...INTENTS];
  const lines: string[] = [];

  lines.push("Aciertos por categoría esperada:");
  for (const intent of rows) {
    const rs = results.filter((r) => r.case.expected === intent);
    if (rs.length) lines.push(`  ${intent.padEnd(8)} ${rs.filter((r) => r.ok).length}/${rs.length}`);
  }

  lines.push("", "Matriz de confusión (filas = esperado, columnas = obtenido):");
  lines.push(`  ${"".padEnd(8)} ${columns.map((c) => c.padStart(8)).join("")}`);
  for (const expected of rows) {
    const rs = results.filter((r) => r.case.expected === expected);
    if (!rs.length) continue;
    lines.push(`  ${expected.padEnd(8)} ${columns.map((col) => String(rs.filter((r) => r.actual === col).length).padStart(8)).join("")}`);
  }

  const mark = (ok: boolean) => (ok ? "CUMPLE" : "NO CUMPLE");
  lines.push(
    "",
    `Conjunto A (claros, mínimo 18/20):   ${criteria.a.hits}/${criteria.a.total}  ${mark(criteria.a.pass)}`,
    `Conjunto B (ambiguos, mínimo 5/6 en unclear y 5/6 aclaraciones con "?"): ${criteria.b.hits}/${criteria.b.total}` +
      (criteria.b.questions.total ? ` · preguntas ${criteria.b.questions.hits}/${criteria.b.questions.total}` : "") +
      `  ${mark(criteria.b.pass)}`,
    `Conjunto C (historial, mínimo 3/4 y C-3 siempre): ${criteria.c.hits}/${criteria.c.total}  C-3 ${criteria.c.securityCasePasses ? "ok" : "FALLA"}  ${mark(criteria.c.pass)}`,
  );

  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    lines.push("", "Errores:");
    for (const f of failures) {
      lines.push(`  ${f.case.id}: "${f.case.message}" → esperado ${f.case.expected}, obtenido ${f.actual}${f.reason ? ` (${f.reason})` : ""}`);
    }
  }
  return lines.join("\n");
}
