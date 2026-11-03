import { HumanMessage } from "@langchain/core/messages";
import type { Intent } from "../src/graph/intents.js";
import { makeRouterNode, ROUTER_FALLBACK_REASON, type RouterModel } from "../src/graph/nodes/router.js";
import { makeState } from "../src/graph/state.js";
import { PLAN_CASES, type PlanCase } from "./plan-cases.js";

// Evalúa al router como planificador (fase 7): en qué tareas parte cada mensaje, con el modelo real. Se mira el plan
// YA normalizado por el código, que es el que recorre el supervisor.

export interface PlanCaseResult {
  case: PlanCase;
  ok: boolean;
  /** Intenciones del plan, en orden. */
  observed: Intent[];
  /** Lo que el router escribió en cada tarea, para leer el informe. */
  requests: string[];
  reason: string;
  /** La salida del modelo no cumplió el esquema y se usó el respaldo. */
  fallback: boolean;
}

export async function evaluatePlans(router: RouterModel, cases: PlanCase[] = PLAN_CASES): Promise<PlanCaseResult[]> {
  const node = makeRouterNode(router, { warn: () => {} });
  const results: PlanCaseResult[] = [];
  for (const c of cases) {
    const update = await node(makeState([new HumanMessage(c.message)]));
    const observed = update.plan.tasks.map((t) => t.intent);
    const fallback = update.intentReason === ROUTER_FALLBACK_REASON;
    results.push({
      case: c,
      ok: !fallback && observed.join(",") === c.expected.join(","),
      observed,
      requests: update.plan.tasks.map((t) => t.request),
      reason: update.intentReason,
      fallback,
    });
  }
  return results;
}

export interface PlanCriteria {
  hits: number;
  total: number;
  criticalPass: boolean;
  pass: boolean;
}

/** CA6: al menos 7 de 8, y M1, M7 y M8 nunca pueden fallar. */
export function checkPlanCriteria(results: PlanCaseResult[]): PlanCriteria {
  const hits = results.filter((r) => r.ok).length;
  const criticalPass = results.filter((r) => r.case.critical).every((r) => r.ok);
  return { hits, total: results.length, criticalPass, pass: hits >= 7 && criticalPass };
}

export function formatPlanReport(results: PlanCaseResult[]): string {
  const lines = ["Plan del router con el modelo real (escenarios M1 a M8):", ""];
  for (const r of results) {
    lines.push(`${r.ok ? "✔" : "✖"} ${r.case.id}${r.case.critical ? " (crítico)" : ""}  ${r.case.message}`);
    lines.push(`     esperado: ${r.case.expected.join(" → ")} · salió: ${r.fallback ? "RESPALDO (salida inválida)" : r.observed.join(" → ")}`);
    r.requests.forEach((req, i) => lines.push(`       ${i + 1}. ${req}`));
  }
  const c = checkPlanCriteria(results);
  lines.push("", `Aciertos: ${c.hits}/${c.total} · críticos (M1, M7 y M8): ${c.criticalPass ? "bien" : "FALLÓ"} · ${c.pass ? "CUMPLE" : "NO CUMPLE"}`);
  return lines.join("\n");
}
