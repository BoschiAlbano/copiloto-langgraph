import { describe, expect, it } from "vitest";
import { INTENTS, routerOutputSchema } from "../src/graph/intents.js";

describe("routerOutputSchema", () => {
  it("acepta cada una de las cinco intenciones", () => {
    expect(INTENTS).toEqual(["query", "action", "report", "chat", "unclear"]);
    for (const intent of INTENTS) {
      expect(routerOutputSchema.safeParse({ reason: "motivo", intent }).success, intent).toBe(true);
    }
  });

  it("rechaza intenciones inventadas, motivos vacíos o demasiado largos y campos que faltan", () => {
    expect(routerOutputSchema.safeParse({ reason: "x", intent: "borrar" }).success).toBe(false);
    expect(routerOutputSchema.safeParse({ reason: "", intent: "query" }).success).toBe(false);
    expect(routerOutputSchema.safeParse({ reason: "x".repeat(161), intent: "query" }).success).toBe(false);
    expect(routerOutputSchema.safeParse({ intent: "query" }).success).toBe(false);
    expect(routerOutputSchema.safeParse({ reason: "x" }).success).toBe(false);
  });

  it("declara el motivo antes que la intención", () => {
    expect(Object.keys(routerOutputSchema.shape)).toEqual(["reason", "intent"]);
  });
});
