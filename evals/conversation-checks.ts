// Las reglas del set de evaluación (fase 11, R8): funciones sobre lo que se observó en el último turno de un caso.
// No llaman al modelo. El SQL de las respuestas correctas se pasa como dependencia (`sql`), así se prueban sin base.
import type { TurnResult } from "../src/graph/run-turn.js";
import type { Check, FromSql } from "./conversation-cases.js";

/** Lo que se observó del último turno de un caso (con su continuación, si se rechazó una tarjeta). */
export interface TurnObservation {
  /** La respuesta final (la de después de rechazar, si hubo tarjeta). */
  reply: string;
  /** Las tareas del plan del router, en orden. */
  route: string[];
  /** Las herramientas de consulta que se pidieron, en orden, con sus argumentos. */
  tools: { name: string; args: Record<string, unknown> }[];
  /** Las acciones que se propusieron (cada tarjeta). */
  proposals: { tool: string; params: Record<string, unknown> }[];
  report?: TurnResult["report"];
  /** Los textos de las memorias del negocio antes y después del caso. */
  memoriesBefore: string[];
  memoriesAfter: string[];
}

export interface CheckResult {
  ok: boolean;
  /** Qué se esperaba y qué pasó, para el informe. */
  detail: string;
}

/** Corre una consulta y devuelve la primera columna de cada fila. */
export type SqlRunner = (sql: string) => Promise<unknown[]>;

// --- Normalización ------------------------------------------------------------------------------------------------

/** Minúsculas y sin tildes: para buscar nombres sin depender de cómo los escribió el modelo. */
export const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Saca los separadores de miles: «$ 114.000» y «114 000» → «114000». */
export const plainNumbers = (text: string) => text.replace(/(?<=\d)[.\s ](?=\d{3}\b)/g, "");

/** ¿El texto tiene ese número suelto? (Un 0 vale también como «no hubo», «no hay», «ninguno».) */
export function hasNumber(text: string, value: number): boolean {
  if (new RegExp(`(?<![\\d.,])${value}(?![\\d]|[.,]\\d)`).test(plainNumbers(text))) return true;
  return value === 0 && /\b(no hubo|no hay|no tiene|ningun[oa]?|sin (ventas|turnos)|cero)\b/i.test(fold(text));
}

/** ¿El texto tiene esa hora? «11:30» o «11.30»; si es en punto, también «15 h», «15 hs» o «15hs». */
export function hasTime(text: string, hhmm: string): boolean {
  const [h, m] = hhmm.split(":");
  const hour = String(Number(h));
  const variants = [`${h}:${m}`, `${hour}:${m}`, `${h}\\.${m}`, `${hour}\\.${m}`];
  if (m === "00") variants.push(`${hour}\\s?h(s|oras)?\\b`);
  return new RegExp(`(?<!\\d)(${variants.join("|")})`, "i").test(text);
}

/** ¿`actual` tiene todo lo de `expected`? Los objetos se comparan por sus claves; las listas, elemento a elemento. */
export function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((e) => actual.some((a) => matchesSubset(a, e)));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => matchesSubset((actual as Record<string, unknown>)[k], v));
  }
  if (typeof expected === "string" && typeof actual === "string") return fold(actual) === fold(expected);
  return actual === expected;
}

const isFromSql = (v: unknown): v is FromSql => Boolean(v && typeof v === "object" && "sql" in v && typeof (v as FromSql).sql === "string");
const show = (v: unknown) => JSON.stringify(v);
const ok = (detail: string): CheckResult => ({ ok: true, detail });
const fail = (detail: string): CheckResult => ({ ok: false, detail });

/** Los parámetros esperados con los valores de SQL ya resueltos. */
async function resolveParams(params: Record<string, unknown>, sql: SqlRunner) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) out[k] = isFromSql(v) ? Number((await sql(v.sql))[0]) : v;
  return out;
}

// --- Las reglas ---------------------------------------------------------------------------------------------------

export async function evaluateCheck(check: Check, obs: TurnObservation, sql: SqlRunner): Promise<CheckResult> {
  switch (check.kind) {
    case "route": {
      const pass = obs.route.length === check.intents.length && check.intents.every((i, n) => obs.route[n] === i);
      return pass ? ok(`ruta ${check.intents.join(" → ")}`) : fail(`ruta esperada ${check.intents.join(" → ")}, fue ${obs.route.join(" → ") || "(ninguna)"}`);
    }
    case "usesTools": {
      const names = obs.tools.map((t) => t.name);
      const missing = check.tools.filter((t) => !names.includes(t));
      if (missing.length) return fail(`faltó usar ${missing.join(", ")} (usó ${names.join(", ") || "ninguna"})`);
      if (check.inOrder) {
        const positions = check.tools.map((t) => names.indexOf(t));
        if (positions.some((p, i) => i > 0 && p < positions[i - 1]!)) return fail(`orden esperado ${check.tools.join(" → ")}, fue ${names.join(" → ")}`);
      }
      return ok(`usó ${check.tools.join(", ")}`);
    }
    case "noTools":
      return obs.tools.length === 0 ? ok("sin herramientas") : fail(`usó herramientas que no hacían falta: ${obs.tools.map((t) => t.name).join(", ")}`);
    case "toolArgs": {
      const call = obs.tools.find((t) => t.name === check.tool);
      if (!call) return fail(`no usó ${check.tool}`);
      return matchesSubset(call.args, check.args) ? ok(`${check.tool} con ${show(check.args)}`) : fail(`${check.tool} con ${show(call.args)}; se esperaba ${show(check.args)}`);
    }
    case "proposes": {
      const expected = await resolveParams(check.params, sql);
      const card = obs.proposals.find((p) => p.tool === check.tool);
      if (!card) return fail(`no propuso ${check.tool} (propuso ${obs.proposals.map((p) => p.tool).join(", ") || "nada"})`);
      return matchesSubset(card.params, expected) ? ok(`propuso ${check.tool} con ${show(expected)}`) : fail(`propuso ${check.tool} con ${show(card.params)}; se esperaba ${show(expected)}`);
    }
    case "noProposal":
      return obs.proposals.length === 0 ? ok("no propuso acciones") : fail(`propuso ${obs.proposals.map((p) => p.tool).join(", ")}`);
    case "replyHasSqlNumbers": {
      const values = (await sql(check.sql)).map(Number);
      const missing = values.filter((v) => !hasNumber(obs.reply, v));
      return missing.length === 0 ? ok(`la respuesta tiene ${check.what} (${values.join(", ")})`) : fail(`la respuesta no tiene ${check.what}: falta ${missing.join(", ")}`);
    }
    case "replyHasSqlTimes": {
      const values = (await sql(check.sql)).map(String);
      const missing = values.filter((v) => !hasTime(obs.reply, v));
      return missing.length === 0 ? ok(`la respuesta tiene ${check.what} (${values.join(", ")})`) : fail(`la respuesta no tiene ${check.what}: falta ${missing.join(", ")}`);
    }
    case "replyHasSqlTexts": {
      const values = (await sql(check.sql)).map(String);
      const reply = fold(obs.reply);
      const missing = values.filter((v) => !reply.includes(fold(v)));
      return missing.length === 0 ? ok(`la respuesta nombra ${check.what}`) : fail(`la respuesta no nombra ${check.what}: falta ${missing.join(", ")}`);
    }
    case "replyMatches":
      return check.pattern.test(obs.reply) ? ok(`la respuesta tiene ${check.what}`) : fail(`la respuesta no tiene ${check.what}`);
    case "replyExcludes": {
      const found = obs.reply.match(check.pattern);
      return found ? fail(`la respuesta tiene ${check.what} («${found[0]}»)`) : ok(`la respuesta no tiene ${check.what}`);
    }
    case "asksQuestion":
      return obs.reply.trim().endsWith("?") ? ok("contestó con una pregunta") : fail("no contestó con una pregunta");
    case "reportSections": {
      if (!obs.report) return fail("no hubo reporte");
      const bad = Object.entries(obs.report.sections).filter(([, s]) => s !== "ok");
      return bad.length === 0 ? ok("las tres secciones bien") : fail(`secciones que no salieron: ${bad.map(([s, st]) => `${s} (${st})`).join(", ")}`);
    }
    case "reportRange": {
      if (!obs.report?.dateFrom) return fail("no hubo reporte con período");
      const froms = Array.isArray(check.dateFrom) ? check.dateFrom : [check.dateFrom];
      const pass = froms.includes(obs.report.dateFrom) && obs.report.dateTo === check.dateTo;
      return pass ? ok(`período ${obs.report.dateFrom} a ${obs.report.dateTo}`) : fail(`período ${obs.report.dateFrom} a ${obs.report.dateTo}; se esperaba ${froms.join(" o ")} a ${check.dateTo}`);
    }
    case "memorySaved": {
      const added = obs.memoriesAfter.filter((m) => !obs.memoriesBefore.includes(m));
      return added.some((m) => check.pattern.test(m)) ? ok(`anotó: ${added.join(" / ")}`) : fail(`no anotó una memoria con ${check.pattern} (anotó: ${added.join(" / ") || "nada"})`);
    }
    case "memoryUnchanged": {
      const same = obs.memoriesBefore.length === obs.memoriesAfter.length && obs.memoriesAfter.every((m) => obs.memoriesBefore.includes(m));
      return same ? ok("no cambió las memorias") : fail(`cambió las memorias: ${obs.memoriesAfter.filter((m) => !obs.memoriesBefore.includes(m)).join(" / ") || "borró alguna"}`);
    }
  }
}

/** Todas las reglas de un caso. Pasa si cumple todas. */
export async function evaluateChecks(checks: Check[], obs: TurnObservation, sql: SqlRunner) {
  const results = [];
  for (const check of checks) results.push({ check: check.kind, ...(await evaluateCheck(check, obs, sql)) });
  return { passed: results.every((r) => r.ok), results };
}
