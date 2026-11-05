import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { InMemoryStore } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import { describeRoute } from "../src/cli/format.js";
import { routerOutputSchema } from "../src/graph/intents.js";
import { makeMemoryNode } from "../src/graph/nodes/memory.js";
import { makePlanReportNode } from "../src/graph/nodes/report.js";
import { makeRouterNode } from "../src/graph/nodes/router.js";
import { PLAN_FALLBACK_REASON } from "../src/graph/plan.js";
import { invokeWithCorrection, zodCheck, type StructuredModel } from "../src/graph/structured.js";
import { listMemories } from "../src/memory/store.js";
import { isFallbackRoute } from "../src/web/turn-view.js";

// Fase 10 (T5, R8, CA3): una salida mal formada se corrige con un segundo intento, o se reporta.

/** Un modelo con salida estructurada que contesta una salida por llamada (y guarda lo que recibió). */
function sequence(...outputs: unknown[]) {
  const calls: BaseMessage[][] = [];
  const model: StructuredModel = {
    async invoke(messages) {
      calls.push(messages);
      const out = outputs[Math.min(calls.length - 1, outputs.length - 1)];
      return { parsed: out, raw: new AIMessage({ content: "", tool_calls: [{ id: "t", name: "route", args: (out ?? {}) as Record<string, unknown>, type: "tool_call" }] }) };
    },
  };
  return { model, calls };
}
const valid = { reason: "consulta", tasks: [{ intent: "report", request: "resumen" }] };
const invalid = { reason: "consulta", tasks: [{ intent: "borrar", request: "x" }] };
const msgs = [new SystemMessage("sos un router"), new HumanMessage("Conversación: armame el resumen")];

describe("invokeWithCorrection", () => {
  it("una salida válida no pide nada más", async () => {
    const { model, calls } = sequence(valid);
    expect(await invokeWithCorrection(model, msgs, zodCheck(routerOutputSchema))).toEqual({ value: valid, corrected: false });
    expect(calls).toHaveLength(1);
  });

  it("inválida y después válida: se corrige con un segundo intento que dice qué contestó y qué está mal", async () => {
    const warn = vi.fn();
    const { model, calls } = sequence(invalid, valid);
    expect(await invokeWithCorrection(model, msgs, zodCheck(routerOutputSchema), { warn, label: "router" })).toEqual({ value: valid, corrected: true });
    expect(calls).toHaveLength(2);
    // La corrección va en el último mensaje de la persona (sin romper la alternancia persona/IA) y lo de antes no cambia.
    expect(calls[1]).toHaveLength(2);
    expect(calls[1]![0]!.text).toBe("sos un router");
    const correction = calls[1]![1]!.text;
    expect(correction).toMatch(/^Conversación: armame el resumen\n\nTu respuesta anterior no cumplió el formato pedido/);
    expect(correction).toContain('"intent":"borrar"'); // lo que contestó
    expect(correction).toMatch(/«tasks\.0\.intent»/); // qué está mal
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[router\] Salida inválida/));
  });

  it("dos inválidas: sin valor y con el motivo", async () => {
    const { model } = sequence(null, invalid);
    const result = await invokeWithCorrection(model, msgs, zodCheck(routerOutputSchema));
    expect(result.value).toBeUndefined();
    expect(result.corrected).toBe(true);
    expect(result.error).toMatch(/tasks\.0\.intent/);
  });

  it("un error de la API no se atrapa", async () => {
    const model: StructuredModel = { invoke: async () => { throw new Error("529 overloaded"); } };
    await expect(invokeWithCorrection(model, msgs, zodCheck(routerOutputSchema))).rejects.toThrow(/529/);
  });
});

describe("en los tres nodos (CA3)", () => {
  it("router: la corrección da el plan del segundo intento, sin respaldo", async () => {
    const { model, calls } = sequence(invalid, valid);
    const update = await makeRouterNode(model, { warn: () => {} })({ messages: [new HumanMessage("armame el resumen")] });
    expect(update.intent).toBe("report");
    expect(update.intentReason).toBe("consulta");
    expect(calls).toHaveLength(2);
  });

  it("router: dos inválidas usan el respaldo, y la ruta lo dice («(respaldo)»)", async () => {
    const { model } = sequence(invalid);
    const update = await makeRouterNode(model, { warn: () => {} })({ messages: [new HumanMessage("x")] });
    expect(update.intentReason).toBe(PLAN_FALLBACK_REASON);
    expect(isFallbackRoute(update.intentReason)).toBe(true);
    expect(isFallbackRoute("Pregunta por un dato puntual")).toBe(false);
    expect(describeRoute({ intent: "query", reason: update.intentReason })[0]).toBe(`[ruta] query (respaldo): ${PLAN_FALLBACK_REASON}`);
  });

  it("memoria: se corrige y anota; si tampoco sirve, no hace nada y lo dice", async () => {
    const store = new InMemoryStore();
    const bank = { store, namespace: ["test", "structured"] };
    const config = { store } as never;
    const ok = sequence({ operation: "guardar" }, { operation: "save", kind: "rule", text: "Los lunes no se agendan turnos." });
    const saved = await makeMemoryNode(ok.model, { namespace: bank.namespace, warn: () => {} })({ messages: [new HumanMessage("acordate…")] }, config);
    expect(saved.messages[0]!.text).toMatch(/^Anoté esta regla/);
    expect(ok.calls).toHaveLength(2);
    expect(await listMemories(bank)).toHaveLength(1);

    const bad = sequence({ operation: "guardar" });
    const nothing = await makeMemoryNode(bad.model, { namespace: bank.namespace, warn: () => {} })({ messages: [new HumanMessage("acordate…")] }, config);
    expect(nothing.messages[0]!.text).toMatch(/No entendí/);
    expect(await listMemories(bank)).toHaveLength(1);
  });

  it("período del reporte: fechas al revés y después bien → se usan las corregidas, sin aviso a la persona", async () => {
    const now = () => new Date("2026-10-28T15:00:00Z");
    const { model, calls } = sequence(
      { reason: "x", kind: "custom", dateFrom: "2026-10-12", dateTo: "2026-10-05" },
      { reason: "x", kind: "custom", dateFrom: "2026-10-05", dateTo: "2026-10-12" },
    );
    const { report } = await makePlanReportNode(model, { now, newId: () => "r", warn: () => {} })({ messages: [new HumanMessage("del 5 al 12")] });
    expect([report.dateFrom, report.dateTo]).toEqual(["2026-10-05", "2026-10-12"]);
    expect(report.notice).toBeUndefined();
    expect(calls[1]!.at(-1)!.text).toMatch(/las fechas del período no son válidas/);
  });
});
