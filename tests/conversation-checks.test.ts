import { describe, expect, it } from "vitest";
import type { Check } from "../evals/conversation-cases.js";
import { evaluateCheck, evaluateChecks, hasNumber, hasTime, matchesSubset, type TurnObservation } from "../evals/conversation-checks.js";

// Fase 11 (T5, CA4): cada regla, con una salida que la cumple y otra que no. Sin modelo y sin base: el SQL es falso.

const obs = (over: Partial<TurnObservation> = {}): TurnObservation => ({
  reply: "",
  route: ["query"],
  tools: [],
  proposals: [],
  memoriesBefore: [],
  memoriesAfter: [],
  ...over,
});
/** Un «SQL» que devuelve lo que se le diga según el texto de la consulta. */
const sql = (answers: Record<string, unknown[]>) => async (q: string) => answers[q] ?? [];
const check = async (c: Check, o: Partial<TurnObservation>, answers: Record<string, unknown[]> = {}) => (await evaluateCheck(c, obs(o), sql(answers))).ok;

describe("números, horas y textos de la respuesta", () => {
  it("un número con o sin separadores de miles, y no uno que lo contiene", () => {
    expect(hasNumber("Ayer vendieron $ 114.000 en total.", 114000)).toBe(true);
    expect(hasNumber("Ayer: 114 000 pesos.", 114000)).toBe(true);
    expect(hasNumber("Mañana hay **30 turnos** activos.", 30)).toBe(true);
    expect(hasNumber("Mañana hay 300 turnos.", 30)).toBe(false);
    expect(hasNumber("Quedan 3,5 kilos.", 3)).toBe(false);
    expect(hasNumber("Hoy no hubo ventas.", 0)).toBe(true);
    expect(hasNumber("Hoy hubo ventas.", 0)).toBe(false);
  });

  it("una hora en sus formas comunes", () => {
    expect(hasTime("Es mañana a las 11:30 con Lucas.", "11:30")).toBe(true);
    expect(hasTime("a las 11.30", "11:30")).toBe(true);
    expect(hasTime("a las 9:15", "09:15")).toBe(true);
    expect(hasTime("a las 15 hs", "15:00")).toBe(true);
    expect(hasTime("a las 21:30", "11:30")).toBe(false);
    expect(hasTime("a las 11:45", "11:30")).toBe(false);
  });

  it("los parámetros: subconjunto de objetos, listas con los mismos elementos, textos sin tildes ni mayúsculas", () => {
    expect(matchesSubset({ sku: "CER-001", delta: 5, reason: "x" }, { sku: "CER-001", delta: 5 })).toBe(true);
    expect(matchesSubset({ items: [{ sku: "CER-001", qty: 2, price: 1 }] }, { items: [{ sku: "CER-001", qty: 2 }] })).toBe(true);
    expect(matchesSubset({ items: [{ sku: "CER-001", qty: 2 }, { sku: "GEL-001", qty: 1 }] }, { items: [{ sku: "CER-001", qty: 2 }] })).toBe(false);
    expect(matchesSubset({ staffName: "martin" }, { staffName: "Martín" })).toBe(true);
    expect(matchesSubset({ delta: -3 }, { delta: 3 })).toBe(false);
  });
});

describe("cada regla, una vez que se cumple y otra que no", () => {
  it("route", async () => {
    expect(await check({ kind: "route", intents: ["action", "query"] }, { route: ["action", "query"] })).toBe(true);
    expect(await check({ kind: "route", intents: ["action", "query"] }, { route: ["query", "action"] })).toBe(false);
    expect(await check({ kind: "route", intents: ["query"] }, { route: ["query", "report"] })).toBe(false);
  });

  it("usesTools, con y sin orden", async () => {
    const tools = [{ name: "findClient", args: {} }, { name: "listAppointments", args: {} }];
    expect(await check({ kind: "usesTools", tools: ["findClient", "listAppointments"], inOrder: true }, { tools })).toBe(true);
    expect(await check({ kind: "usesTools", tools: ["listAppointments", "findClient"], inOrder: true }, { tools })).toBe(false);
    expect(await check({ kind: "usesTools", tools: ["listAppointments", "findClient"] }, { tools })).toBe(true);
    expect(await check({ kind: "usesTools", tools: ["getStockLevels"] }, { tools })).toBe(false);
  });

  it("noTools y toolArgs", async () => {
    expect(await check({ kind: "noTools" }, { tools: [] })).toBe(true);
    expect(await check({ kind: "noTools" }, { tools: [{ name: "findClient", args: {} }] })).toBe(false);
    const tools = [{ name: "listAppointments", args: { staffName: "Lucas", dateFrom: "2026-11-06" } }];
    expect(await check({ kind: "toolArgs", tool: "listAppointments", args: { staffName: "Lucas" } }, { tools })).toBe(true);
    expect(await check({ kind: "toolArgs", tool: "listAppointments", args: { staffName: "Martín" } }, { tools })).toBe(false);
  });

  it("proposes (con un parámetro que sale de SQL) y noProposal", async () => {
    const proposals = [{ tool: "cancelAppointment", params: { appointmentId: 1771 } }];
    const next = { kind: "proposes", tool: "cancelAppointment", params: { appointmentId: { sql: "PRÓXIMO" } } } as const;
    expect(await check(next, { proposals }, { PRÓXIMO: [1771] })).toBe(true);
    expect(await check(next, { proposals }, { PRÓXIMO: [1773] })).toBe(false);
    expect(await check({ kind: "proposes", tool: "registerSale", params: {} }, { proposals })).toBe(false);
    expect(await check({ kind: "noProposal" }, { proposals: [] })).toBe(true);
    expect(await check({ kind: "noProposal" }, { proposals })).toBe(false);
  });

  it("replyHasSqlNumbers, replyHasSqlTimes y replyHasSqlTexts: cada fila del SQL", async () => {
    const reply = "Ayer: efectivo $ 35.000, tarjeta $ 33.000 y transferencia $ 46.000. El próximo turno es a las 11:30. Bajos: Cera brillo, Peine de carey.";
    expect(await check({ kind: "replyHasSqlNumbers", sql: "Q", what: "x" }, { reply }, { Q: [35000, 33000, 46000] })).toBe(true);
    expect(await check({ kind: "replyHasSqlNumbers", sql: "Q", what: "x" }, { reply }, { Q: [35000, 99999] })).toBe(false);
    expect(await check({ kind: "replyHasSqlTimes", sql: "Q", what: "x" }, { reply }, { Q: ["11:30"] })).toBe(true);
    expect(await check({ kind: "replyHasSqlTimes", sql: "Q", what: "x" }, { reply }, { Q: ["12:00"] })).toBe(false);
    expect(await check({ kind: "replyHasSqlTexts", sql: "Q", what: "x" }, { reply }, { Q: ["Cera brillo", "Peine de carey"] })).toBe(true);
    expect(await check({ kind: "replyHasSqlTexts", sql: "Q", what: "x" }, { reply }, { Q: ["Acondicionador", "Cera brillo"] })).toBe(false);
  });

  it("replyMatches, replyExcludes y asksQuestion", async () => {
    expect(await check({ kind: "replyMatches", pattern: /lunes/i, what: "x" }, { reply: "Los lunes no se agenda." })).toBe(true);
    expect(await check({ kind: "replyMatches", pattern: /lunes/i, what: "x" }, { reply: "Listo." })).toBe(false);
    expect(await check({ kind: "replyExcludes", pattern: /próximamente/i, what: "x" }, { reply: "Puedo agendar turnos." })).toBe(true);
    expect(await check({ kind: "replyExcludes", pattern: /próximamente/i, what: "x" }, { reply: "Próximamente voy a poder agendar." })).toBe(false);
    expect(await check({ kind: "asksQuestion" }, { reply: "¿Qué turno querés cancelar?" })).toBe(true);
    expect(await check({ kind: "asksQuestion" }, { reply: "Cancelé el turno." })).toBe(false);
  });

  it("reportSections y reportRange (con más de un comienzo aceptable)", async () => {
    const report = { label: "x", dateFrom: "2026-10-07", dateTo: "2026-11-05", sections: { sales: "ok", appointments: "ok", stock: "ok" } } as const;
    expect(await check({ kind: "reportSections" }, { report })).toBe(true);
    expect(await check({ kind: "reportSections" }, { report: { ...report, sections: { ...report.sections, stock: "error" } } })).toBe(false);
    expect(await check({ kind: "reportSections" }, {})).toBe(false);
    expect(await check({ kind: "reportRange", dateFrom: ["2026-10-07", "2026-10-06"], dateTo: "2026-11-05" }, { report })).toBe(true);
    expect(await check({ kind: "reportRange", dateFrom: "2026-10-01", dateTo: "2026-11-05" }, { report })).toBe(false);
  });

  it("memorySaved y memoryUnchanged", async () => {
    const before = ["Decí los montos en pesos."];
    expect(await check({ kind: "memorySaved", pattern: /lunes/i }, { memoriesBefore: before, memoriesAfter: [...before, "Los lunes no se agendan turnos."] })).toBe(true);
    expect(await check({ kind: "memorySaved", pattern: /lunes/i }, { memoriesBefore: before, memoriesAfter: before })).toBe(false);
    expect(await check({ kind: "memoryUnchanged" }, { memoriesBefore: before, memoriesAfter: before })).toBe(true);
    expect(await check({ kind: "memoryUnchanged" }, { memoriesBefore: before, memoriesAfter: [...before, "Bruno paga con transferencia."] })).toBe(false);
  });
});

it("un caso pasa solo si cumple todas sus reglas, y el informe dice cuál falló", async () => {
  const result = await evaluateChecks(
    [{ kind: "noTools" }, { kind: "asksQuestion" }],
    obs({ reply: "Cancelé el turno." }),
    sql({}),
  );
  expect(result.passed).toBe(false);
  expect(result.results.map((r) => [r.check, r.ok])).toEqual([
    ["noTools", true],
    ["asksQuestion", false],
  ]);
  expect(result.results[1]!.detail).toBe("no contestó con una pregunta");
});
