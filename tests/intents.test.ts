import { describe, expect, it } from "vitest";
import { INTENTS, MAX_TASKS, routerOutputSchema } from "../src/graph/intents.js";

const plan = (...tasks: { intent: string; request: string }[]) => ({ reason: "motivo", tasks });

describe("routerOutputSchema", () => {
  it("acepta cada una de las cinco intenciones", () => {
    expect(INTENTS).toEqual(["query", "action", "report", "chat", "unclear"]);
    for (const intent of INTENTS) {
      expect(routerOutputSchema.safeParse(plan({ intent, request: "x" })).success, intent).toBe(true);
    }
  });

  it("acepta de 1 a 3 tareas (fase 7)", () => {
    expect(MAX_TASKS).toBe(3);
    const t = { intent: "query", request: "x" };
    expect(routerOutputSchema.safeParse(plan(t, t, t)).success).toBe(true);
    expect(routerOutputSchema.safeParse(plan()).success).toBe(false);
    expect(routerOutputSchema.safeParse(plan(t, t, t, t)).success).toBe(false);
  });

  it("rechaza intenciones inventadas, motivos o pedidos vacíos o demasiado largos y campos que faltan", () => {
    expect(routerOutputSchema.safeParse(plan({ intent: "borrar", request: "x" })).success).toBe(false);
    expect(routerOutputSchema.safeParse({ ...plan({ intent: "query", request: "x" }), reason: "" }).success).toBe(false);
    expect(routerOutputSchema.safeParse({ ...plan({ intent: "query", request: "x" }), reason: "x".repeat(161) }).success).toBe(false);
    expect(routerOutputSchema.safeParse(plan({ intent: "query", request: "" })).success).toBe(false);
    expect(routerOutputSchema.safeParse(plan({ intent: "query", request: "x".repeat(301) })).success).toBe(false);
    expect(routerOutputSchema.safeParse({ tasks: [{ intent: "query", request: "x" }] }).success).toBe(false);
    expect(routerOutputSchema.safeParse({ reason: "x" }).success).toBe(false);
    expect(routerOutputSchema.safeParse({ reason: "x", intent: "query" }).success).toBe(false); // formato de la fase 3
  });

  it("declara el motivo antes que las tareas", () => {
    expect(Object.keys(routerOutputSchema.shape)).toEqual(["reason", "tasks"]);
  });
});
