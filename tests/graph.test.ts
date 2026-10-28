import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { buildTestGraph } from "./helpers/graph.js";
import type { AgentModel } from "../src/graph/nodes/agent.js";

/** Modelo falso: responde con un texto fijo y guarda lo que recibió. */
function fakeModel(replyText: string) {
  const calls: BaseMessage[][] = [];
  const model: AgentModel = {
    async invoke(messages) {
      calls.push(messages);
      return new AIMessage(replyText);
    },
  };
  return { model, calls };
}

describe("grafo sin herramientas (conversación simple)", () => {
  it("agrega la respuesta del modelo al historial", async () => {
    const { model } = fakeModel("Hola, Ana");
    const graph = buildTestGraph({ model, tools: [] });

    const result = await graph.invoke({ messages: [new HumanMessage("Hola, soy Ana")] });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]?.content).toBe("Hola, Ana");
  });

  it("el segundo turno recibe el historial que devolvió el primero", async () => {
    const { model, calls } = fakeModel("ok");
    const graph = buildTestGraph({ model, tools: [] });

    const turn1 = await graph.invoke({ messages: [new HumanMessage("Me llamo Ana")] });
    await graph.invoke({ messages: [...turn1.messages, new HumanMessage("¿Cómo me llamo?")] });

    // El modelo ve: system + (humano, IA, humano) en la segunda llamada.
    const secondCall = calls[1]!;
    expect(secondCall).toHaveLength(4);
    expect(secondCall[1]?.content).toBe("Me llamo Ana");
    expect(secondCall[3]?.content).toBe("¿Cómo me llamo?");
  });

  it("antepone el prompt del sistema sin guardarlo en el estado", async () => {
    const { model, calls } = fakeModel("ok");
    const graph = buildTestGraph({ model, tools: [] });

    const result = await graph.invoke({ messages: [new HumanMessage("hola")] });

    expect(calls[0]?.[0]?.type).toBe("system");
    expect(result.messages.some((m: BaseMessage) => m.type === "system")).toBe(false);
  });
});
