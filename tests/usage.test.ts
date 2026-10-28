import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "../src/config/pricing.js";
import { summarizeTurn } from "../src/graph/usage.js";

describe("summarizeTurn", () => {
  it("suma tokens de todas las llamadas al modelo y lista las herramientas usadas", () => {
    const summary = summarizeTurn([
      new HumanMessage("¿cuántos turnos hay mañana?"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "1", name: "listAppointments", args: { dateFrom: "2026-10-28" }, type: "tool_call" }],
        usage_metadata: { input_tokens: 1500, output_tokens: 60, total_tokens: 1560 },
      }),
      new ToolMessage({ content: "{}", tool_call_id: "1" }),
      new AIMessage({ content: "Hay 23.", usage_metadata: { input_tokens: 1800, output_tokens: 20, total_tokens: 1820 } }),
    ]);
    expect(summary).toEqual({
      modelCalls: 2,
      toolCalls: [{ name: "listAppointments", args: { dateFrom: "2026-10-28" } }],
      inputTokens: 3300,
      outputTokens: 80,
    });
  });

  it("tolera respuestas sin datos de uso", () => {
    expect(summarizeTurn([new AIMessage("hola")])).toMatchObject({ modelCalls: 1, inputTokens: 0, outputTokens: 0 });
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
