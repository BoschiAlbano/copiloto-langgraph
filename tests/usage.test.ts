import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "../src/config/pricing.js";
import { summarizeTurn } from "../src/graph/usage.js";
import { costOfUsage, mergeUsage, totalUsage, UsageTracker } from "../src/graph/usage-tracker.js";

/** Evento de fin de una llamada al modelo, como lo emite LangChain. */
const llmEnd = (model: string | undefined, input: number, output: number): LLMResult =>
  ({
    generations: [
      [
        {
          text: "",
          message: new AIMessage({
            content: "x",
            response_metadata: model ? { model } : {},
            usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output },
          }),
        } as ChatGeneration,
      ],
    ],
  }) as LLMResult;

describe("UsageTracker", () => {
  it("suma tokens y llamadas por modelo", () => {
    const tracker = new UsageTracker();
    tracker.handleLLMEnd(llmEnd("claude-haiku-5-5", 700, 30)); // router
    tracker.handleLLMEnd(llmEnd("claude-sonnet-5-5", 2500, 80)); // agente
    tracker.handleLLMEnd(llmEnd("claude-sonnet-5-5", 3000, 120)); // agente, segunda llamada
    tracker.handleLLMEnd(llmEnd("claude-haiku-5-5", 600, 25)); // aclaración

    expect(tracker.usage()).toEqual([
      { model: "claude-haiku-5-5", calls: 2, inputTokens: 1300, outputTokens: 55 },
      { model: "claude-sonnet-5-5", calls: 2, inputTokens: 5500, outputTokens: 200 },
    ]);
    expect(totalUsage(tracker.usage())).toEqual({ calls: 4, inputTokens: 6800, outputTokens: 255 });
  });

  it("espera a los handlers para que los totales estén listos al terminar el turno", () => {
    expect(new UsageTracker().awaitHandlers).toBe(true);
  });

  it("cuenta la llamada aunque no traiga datos de uso ni modelo", () => {
    const tracker = new UsageTracker();
    tracker.handleLLMEnd({ generations: [[{ text: "hola" }]] } as LLMResult);
    expect(tracker.usage()).toEqual([{ model: "desconocido", calls: 1, inputTokens: 0, outputTokens: 0 }]);
  });

  it("devuelve copias: modificar el resultado no altera lo acumulado", () => {
    const tracker = new UsageTracker();
    tracker.handleLLMEnd(llmEnd("claude-haiku-5-5", 10, 1));
    tracker.usage()[0]!.calls = 99;
    expect(tracker.usage()[0]!.calls).toBe(1);
  });
});

describe("costOfUsage y mergeUsage", () => {
  const haiku = { model: "claude-haiku-5-5", calls: 1, inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const sonnet = { model: "claude-sonnet-5-5", calls: 1, inputTokens: 1_000_000, outputTokens: 0 };

  it("suma el costo de cada modelo con su propio precio", () => {
    expect(costOfUsage([haiku, sonnet])).toBeCloseTo(0.6 + 2);
  });

  it("devuelve null si algún modelo no tiene precio", () => {
    expect(costOfUsage([haiku, { model: "otro", calls: 1, inputTokens: 1, outputTokens: 1 }])).toBeNull();
  });

  it("junta varios turnos en un renglón por modelo", () => {
    expect(mergeUsage([haiku], [haiku, sonnet])).toEqual([
      { model: "claude-haiku-5-5", calls: 2, inputTokens: 2_000_000, outputTokens: 2_000_000 },
      sonnet,
    ]);
  });
});

describe("summarizeTurn", () => {
  it("lista las herramientas de los mensajes y toma los tokens del tracker", () => {
    const usage = [{ model: "claude-haiku-5-5", calls: 3, inputTokens: 3300, outputTokens: 80 }];
    const summary = summarizeTurn(
      [
        new HumanMessage("¿cuántos turnos hay mañana?"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "1", name: "listAppointments", args: { dateFrom: "2026-10-28" }, type: "tool_call" }],
        }),
        new ToolMessage({ content: "{}", tool_call_id: "1" }),
        new AIMessage("Hay 23."),
      ],
      usage,
    );
    expect(summary).toEqual({
      modelCalls: 3, // el router también cuenta aunque no deje mensajes
      toolCalls: [{ name: "listAppointments", args: { dateFrom: "2026-10-28" } }],
      actions: [],
      failedTools: [], // fase 10: ninguna herramienta terminó con error
      inputTokens: 3300,
      outputTokens: 80,
      usage,
    });
  });

  it("separa las acciones decididas: el texto del código, no el del modelo", () => {
    const summary = summarizeTurn(
      [
        new AIMessage({ content: "", tool_calls: [{ id: "1", name: "cancelAppointment", args: { appointmentId: 7 }, type: "tool_call" }] }),
        new ToolMessage({ content: "Turno #7 cancelado.", tool_call_id: "1", name: "cancelAppointment" }),
        new AIMessage({ content: "", tool_calls: [{ id: "2", name: "adjustStock", args: {}, type: "tool_call" }] }),
        new ToolMessage({ content: "No se pudo.", tool_call_id: "2", name: "adjustStock", status: "error" }),
        new ToolMessage({ content: "{}", tool_call_id: "3", name: "findClient" }), // una consulta no es una acción
        new AIMessage("Listo."),
      ],
      [],
    );
    expect(summary.actions).toEqual([
      { tool: "cancelAppointment", ok: true, message: "Turno #7 cancelado." },
      { tool: "adjustStock", ok: false, message: "No se pudo." },
    ]);
  });
});

describe("estimateCostUsd", () => {
  it("usa los precios del plan por millón de tokens", () => {
    expect(estimateCostUsd("claude-haiku-5-5", 1_000_000, 1_000_000)).toBeCloseTo(0.6);
    expect(estimateCostUsd("claude-sonnet-5-5", 7000, 600)).toBeCloseTo(0.02, 3);
  });

  it("devuelve null para un modelo desconocido", () => {
    expect(estimateCostUsd("otro-modelo", 100, 100)).toBeNull();
  });
});
