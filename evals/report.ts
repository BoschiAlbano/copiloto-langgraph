import { HumanMessage } from "@langchain/core/messages";
import { makePlanReportNode, type PlanModel } from "../src/graph/nodes/report.js";
import { makeState } from "../src/graph/state.js";
import { REPORT_CASES, REPORT_NOW, type ReportCase } from "./report-cases.js";

// Evalúa SOLO al planificador de reportes (qué período elige) con el modelo real y un reloj fijo. Es lo único que el
// modelo decide en un reporte: las fechas, las secciones y las cifras las calcula el código.

export interface PlanCaseResult {
  case: ReportCase;
  ok: boolean;
  observed: { dateFrom: string; dateTo: string; label: string };
  /** Por qué no cumplió, si no cumplió. */
  problem?: string;
}

export async function evaluatePlanner(model: PlanModel, cases: ReportCase[] = REPORT_CASES): Promise<PlanCaseResult[]> {
  const results: PlanCaseResult[] = [];
  const node = makePlanReportNode(model, { now: () => REPORT_NOW, newId: () => "eval", warn: () => {} });
  for (const c of cases) {
    const { report } = await node(makeState([new HumanMessage(c.message)]));
    const expectedFrom = Array.isArray(c.expected.dateFrom) ? c.expected.dateFrom : [c.expected.dateFrom];
    let problem: string | undefined;
    if (report.notice) problem = "la salida del modelo no sirvió y se usó el respaldo (semana actual)";
    else if (!expectedFrom.includes(report.dateFrom) || report.dateTo !== c.expected.dateTo) {
      problem = `se esperaba ${expectedFrom.join(" o ")} a ${c.expected.dateTo} y salió ${report.dateFrom} a ${report.dateTo}`;
    }
    results.push({ case: c, ok: problem === undefined, observed: { dateFrom: report.dateFrom, dateTo: report.dateTo, label: report.label }, ...(problem && { problem }) });
  }
  return results;
}

export interface PlanCriteria {
  hits: number;
  total: number;
  criticalPass: boolean;
  pass: boolean;
}

/** CA6: al menos 7 de 8, y P1, P3 y P6 nunca pueden fallar. */
export function checkPlanCriteria(results: PlanCaseResult[]): PlanCriteria {
  const hits = results.filter((r) => r.ok).length;
  const criticalPass = results.filter((r) => r.case.critical).every((r) => r.ok);
  return { hits, total: results.length, criticalPass, pass: hits >= 7 && criticalPass };
}

export function formatPlanReport(results: PlanCaseResult[]): string {
  const lines = ["Planificador de reportes con el modelo real (reloj fijo: miércoles 28/10/2026):", ""];
  for (const r of results) {
    lines.push(`${r.ok ? "✔" : "✖"} ${r.case.id}${r.case.critical ? " (crítico)" : ""}  ${r.case.message}`);
    lines.push(`     eligió: ${r.observed.label} (${r.observed.dateFrom} a ${r.observed.dateTo})`);
    if (r.problem) lines.push(`     PROBLEMA: ${r.problem}`);
  }
  const c = checkPlanCriteria(results);
  lines.push("", `Aciertos: ${c.hits}/${c.total} · críticos (P1, P3 y P6): ${c.criticalPass ? "bien" : "FALLÓ"} · ${c.pass ? "CUMPLE" : "NO CUMPLE"}`);
  return lines.join("\n");
}
