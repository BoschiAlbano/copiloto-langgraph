import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { buildQueryGraph, routeAfterAgent } from "../../src/agents/query.js";
import { AGENT_RECURSION_LIMIT } from "../../src/graph/limits.js";
import type { Plan } from "../../src/graph/plan.js";
import { scriptedModel, toolCall } from "../helpers/models.js";

// CA3: el subgrafo de consultas se prueba solo, sin router ni supervisor.

let runs = 0;
const getStockLevels = tool(async () => (runs++, JSON.stringify({ lowCount: 2 })), {
  name: "getStockLevels",
  description: "Stock",
  schema: z.strictObject({}),
});
const broken = tool(async () => { throw new Error("se cayó la base"); }, { name: "broken", description: "falla", schema: z.strictObject({}) });

const ask = (text = "¿cuánto stock queda?") => ({ messages: [new HumanMessage(text)] });

describe("subgrafo de consultas (CA3)", () => {
  it("responde sin herramientas: START → agent → END", async () => {
    const m = scriptedModel([new AIMessage("Hola.")]);
    const result = await buildQueryGraph({ model: m.model, tools: [getStockLevels] }).invoke(ask());
    expect(result.messages.map((x) => x.type)).toEqual(["human", "ai"]);
    expect(m.calls[0]![0]!.type).toBe("system");
  });

  it("el ciclo agent ⇄ tools usa su propio ToolNode y vuelve siempre al agente", async () => {
    runs = 0;
    const m = scriptedModel([toolCall("1", "getStockLevels"), new AIMessage("Hay 2 productos bajos.")]);
    const graph = buildQueryGraph({ model: m.model, tools: [getStockLevels] });
    const path: string[] = [];
    for await (const chunk of await graph.stream(ask(), { streamMode: "updates" })) path.push(...Object.keys(chunk));
    expect(path).toEqual(["agent", "tools", "agent"]);
    expect(runs).toBe(1);
  });

  it("un error de herramienta vuelve al modelo como mensaje de error", async () => {
    const m = scriptedModel([toolCall("1", "broken"), new AIMessage("No pude consultar.")]);
    const result = await buildQueryGraph({ model: m.model, tools: [broken] }).invoke(ask());
    const error = result.messages.find((x) => x.type === "tool") as ToolMessage;
    expect(error.status).toBe("error");
    expect(result.messages.at(-1)!.text).toBe("No pude consultar.");
  });

  it("una acción pedida acá no existe como herramienta", async () => {
    const m = scriptedModel([toolCall("1", "cancelAppointment", { appointmentId: 1 }), new AIMessage("No pude.")]);
    const result = await buildQueryGraph({ model: m.model, tools: [getStockLevels] }).invoke(ask());
    expect((result.messages.find((x) => x.type === "tool") as ToolMessage).text).toMatch(/not a valid tool|no existe|not found/i);
  });

  it("respeta el tope solo: 4 rondas pasan y un ciclo sin fin se corta en recover (fase 10)", async () => {
    const four = scriptedModel([...[1, 2, 3, 4].map((i) => toolCall(String(i), "getStockLevels", { query: `producto ${i}` })), new AIMessage("Listo.")]);
    const ok = await buildQueryGraph({ model: four.model, tools: [getStockLevels] }).invoke(ask(), { recursionLimit: AGENT_RECURSION_LIMIT });
    expect(ok.messages.at(-1)!.text).toBe("Listo.");

    const loop = scriptedModel((n) => toolCall(`loop${n}`, "getStockLevels"));
    const cut = await buildQueryGraph({ model: loop.model, tools: [getStockLevels] }).invoke(ask(), { recursionLimit: AGENT_RECURSION_LIMIT });
    expect(cut.messages.at(-1)!.text).toMatch(/^No pude terminar la consulta/);
  });

  it("con su propio checkpointer guarda su historial por hilo", async () => {
    const m = scriptedModel([new AIMessage("uno"), new AIMessage("dos")]);
    const graph = buildQueryGraph({ model: m.model, tools: [], checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "solo-consultas" } };
    await graph.invoke(ask("a"), config);
    const second = await graph.invoke(ask("b"), config);
    expect(second.messages.map((x) => x.text)).toEqual(["a", "uno", "b", "dos"]);
  });

  it("en un pedido de varias partes recibe su tarea y, tras otro agente, la indicación de seguir (R7)", async () => {
    const plan: Plan = {
      tasks: [
        { id: "1", intent: "action", request: "registrá la venta", status: "done", startedAt: 1 },
        { id: "2", intent: "query", request: "decime el stock del gel", status: "running", startedAt: 2 },
      ],
    };
    const m = scriptedModel([new AIMessage("Quedan 11.")]);
    await buildQueryGraph({ model: m.model, tools: [] }).invoke({
      messages: [new HumanMessage("registrá la venta y decime el stock"), new AIMessage("Venta registrada.")],
      plan,
    });
    const [system, ...rest] = m.calls[0]!;
    expect(system!.text).toContain("A vos te toca solo esto: «decime el stock del gel»");
    expect(rest.map((x) => x.type)).toEqual(["human", "ai", "human"]);
  });

  it("routeAfterAgent", () => {
    expect(routeAfterAgent({ messages: [new AIMessage("x")] })).toBe("__end__");
    expect(routeAfterAgent({ messages: [toolCall("1", "getStockLevels")] })).toBe("tools");
    expect(routeAfterAgent({ messages: [] })).toBe("__end__");
  });
});
