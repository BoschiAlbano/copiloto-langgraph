import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { buildTestGraph } from "./helpers/graph.js";
import type { AgentModel } from "../src/graph/nodes/agent.js";

/** Modelo falso guionado: devuelve una respuesta por llamada y guarda lo que recibió. */
function scriptedModel(script: AIMessage[] | ((callNumber: number) => AIMessage)) {
  const calls: BaseMessage[][] = [];
  const model: AgentModel = {
    async invoke(messages) {
      const n = calls.length;
      calls.push(messages);
      const reply = typeof script === "function" ? script(n) : script[n];
      if (!reply) throw new Error(`El guion no tiene respuesta para la llamada ${n + 1}`);
      return reply;
    },
  };
  return { model, calls };
}

const call = (id: string, name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id, name, args, type: "tool_call" }] });

// Herramientas de juguete: no tocan la base.
const countTurns = tool(async ({ day }) => JSON.stringify({ day, total: 7 }), {
  name: "countTurns",
  description: "Cuenta turnos de un día",
  schema: z.strictObject({ day: z.string() }),
});
const getStock = tool(async () => JSON.stringify({ lowCount: 2 }), {
  name: "getStock",
  description: "Stock bajo",
  schema: z.strictObject({}),
});
const broken = tool(
  async () => {
    throw new Error("base de datos inaccesible");
  },
  { name: "broken", description: "Siempre falla", schema: z.strictObject({}) },
);
const tools = [countTurns, getStock, broken];

const types = (messages: BaseMessage[]) => messages.map((m) => m.type);

describe("ciclo agente ↔ herramientas", () => {
  it("pregunta → llamada a herramienta → resultado → respuesta final", async () => {
    const { model, calls } = scriptedModel([
      call("c1", "countTurns", { day: "2026-10-28" }),
      new AIMessage("Mañana hay 7 turnos."),
    ]);
    const result = await buildTestGraph({ model, tools }).invoke({ messages: [new HumanMessage("¿Cuántos turnos hay mañana?")] });

    expect(types(result.messages)).toEqual(["human", "ai", "tool", "ai"]);
    expect(result.messages.at(-1)?.text).toBe("Mañana hay 7 turnos.");
    expect(calls).toHaveLength(2);

    // La segunda llamada al modelo ya ve el resultado de la herramienta.
    const toolMsg = calls[1]!.find((m) => m.type === "tool") as ToolMessage;
    expect(JSON.parse(toolMsg.text)).toEqual({ day: "2026-10-28", total: 7 });
    expect(toolMsg.tool_call_id).toBe("c1");
  });

  it("varias herramientas en un mismo turno se ejecutan y vuelven juntas", async () => {
    const both = new AIMessage({
      content: "",
      tool_calls: [
        { id: "a", name: "countTurns", args: { day: "2026-10-28" }, type: "tool_call" },
        { id: "b", name: "getStock", args: {}, type: "tool_call" },
      ],
    });
    const { model, calls } = scriptedModel([both, new AIMessage("Listo.")]);
    const result = await buildTestGraph({ model, tools }).invoke({ messages: [new HumanMessage("resumen")] });

    expect(types(result.messages)).toEqual(["human", "ai", "tool", "tool", "ai"]);
    expect(calls[1]!.filter((m) => m.type === "tool").map((m) => (m as ToolMessage).tool_call_id)).toEqual(["a", "b"]);
  });

  it("encadena herramientas en pasos sucesivos", async () => {
    const { model } = scriptedModel([
      call("1", "getStock", {}),
      call("2", "countTurns", { day: "2026-10-28" }),
      new AIMessage("Hecho."),
    ]);
    const result = await buildTestGraph({ model, tools }).invoke({ messages: [new HumanMessage("hola")] });
    expect(types(result.messages)).toEqual(["human", "ai", "tool", "ai", "tool", "ai"]);
  });

  it("si la respuesta no pide herramientas, el grafo termina sin pasar por tools", async () => {
    const { model, calls } = scriptedModel([new AIMessage("Hola.")]);
    const result = await buildTestGraph({ model, tools }).invoke({ messages: [new HumanMessage("hola")] });
    expect(types(result.messages)).toEqual(["human", "ai"]);
    expect(calls).toHaveLength(1);
  });
});

describe("errores de herramientas", () => {
  it("una excepción vuelve al modelo como mensaje de error y el ciclo sigue", async () => {
    const { model, calls } = scriptedModel([
      call("x", "broken", {}),
      new AIMessage("No pude consultar los datos."),
    ]);
    const result = await buildTestGraph({ model, tools }).invoke({ messages: [new HumanMessage("¿cuánto vendimos?")] });

    const errorMsg = result.messages.find((m: BaseMessage) => m.type === "tool") as ToolMessage;
    expect(errorMsg.status).toBe("error");
    expect(errorMsg.text).toContain("base de datos inaccesible");
    // El modelo recibe el error en la segunda llamada: así puede informarlo en vez de inventar.
    expect(calls[1]!.some((m) => m.type === "tool" && m.text.includes("base de datos inaccesible"))).toBe(true);
    expect(result.messages.at(-1)?.text).toBe("No pude consultar los datos.");
  });

  it("parámetros que no cumplen el esquema se rechazan como error de herramienta, no como caída", async () => {
    const { model } = scriptedModel([
      call("y", "countTurns", { day: "2026-10-28", sql: "DROP TABLE clients" }),
      new AIMessage("Ok."),
    ]);
    const result = await buildTestGraph({ model, tools }).invoke({ messages: [new HumanMessage("hola")] });
    const toolMsg = result.messages.find((m: BaseMessage) => m.type === "tool") as ToolMessage;
    expect(toolMsg.status).toBe("error");
  });

  it("una herramienta que no existe también vuelve como error", async () => {
    const { model } = scriptedModel([call("z", "runSql", { sql: "select 1" }), new AIMessage("Ok.")]);
    const result = await buildTestGraph({ model, tools }).invoke({ messages: [new HumanMessage("hola")] });
    const toolMsg = result.messages.find((m: BaseMessage) => m.type === "tool") as ToolMessage;
    expect(toolMsg.status).toBe("error");
    expect(toolMsg.text).toMatch(/runSql/);
  });
});

describe("tope de iteraciones", () => {
  it("fase 10: si el modelo pide herramientas sin parar, se corta en recover antes del tope de pasos", async () => {
    const { model, calls } = scriptedModel((n) => call(`loop${n}`, "getStock", {}));
    const graph = buildTestGraph({ model, tools });
    const result = await graph.invoke({ messages: [new HumanMessage("hola")] }, { recursionLimit: 6 });
    expect(result.messages.at(-1)!.text).toMatch(/^No pude terminar la consulta/);
    expect(calls.length).toBe(2);
  });
});

describe("prompt del sistema", () => {
  it("lleva la fecha y hora de Argentina de cada llamada, sin dejar el marcador", async () => {
    const { model, calls } = scriptedModel([new AIMessage("ok")]);
    const now = () => new Date("2026-10-27T18:05:00Z");
    await buildTestGraph({ model, tools, now }).invoke({ messages: [new HumanMessage("hola")] });

    const system = calls[0]![0]!;
    expect(system.type).toBe("system");
    expect(system.text).toContain("martes 27 de octubre de 2026, 15:05");
    expect(system.text).not.toContain("{{");
  });

  it("no se guarda en el estado", async () => {
    const { model } = scriptedModel([new AIMessage("ok")]);
    const result = await buildTestGraph({ model, tools }).invoke({ messages: [new HumanMessage("hola")] });
    expect(result.messages.some((m: BaseMessage) => m.type === "system")).toBe(false);
  });
});
