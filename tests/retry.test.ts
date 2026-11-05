import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import { CLAUDE_MAX_RETRIES, claude } from "../src/graph/models.js";
import { runSection } from "../src/graph/report/sections.js";
import { saveMemory } from "../src/memory/store.js";
import { isTransient, withRetry } from "../src/tools/retry.js";
import { safeTool, ToolUserError } from "../src/tools/safe.js";
import { parseEnv } from "../src/config/env.js";
import { buildTestGraph } from "./helpers/graph.js";
import { scriptedModel, toolCall } from "./helpers/models.js";

// Fase 10 (T2): qué se reintenta y cómo. CA1 sin modelo real.

const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54322"), { code: "ECONNREFUSED" });
const instant = { sleep: async () => {} };

describe("isTransient (R1)", () => {
  it.each([
    ["conexión rechazada (Node)", refused()],
    ["Prisma no llega al servidor", Object.assign(new Error("Can't reach database server"), { code: "P1001" })],
    ["Prisma: el servidor cerró la conexión", Object.assign(new Error("x"), { code: "P1017" })],
    ["Postgres: clase 08 (conexión)", Object.assign(new Error("x"), { code: "08006" })],
    ["Postgres: el servidor se reinicia", Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" })],
    ["Postgres: conflicto de concurrencia", Object.assign(new Error("could not serialize access"), { code: "40001" })],
    ["el error real viene adentro (adaptador de pg)", new Error("DriverAdapterError", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) })],
    ["el pooler sin lugar", new Error("(EMAXCONNSESSION) max clients reached in session mode")],
    ["sin código, por el mensaje", new Error("Connection terminated unexpectedly")],
  ])("transitoria: %s", (_name, error) => {
    expect(isTransient(error)).toBe(true);
  });

  it.each([
    ["un dato inválido", new ToolUserError("No existe el barbero Juancho")],
    ["un permiso", Object.assign(new Error("permission denied for table sales"), { code: "42501" })],
    ["una restricción", Object.assign(new Error("duplicate key"), { code: "23505" })],
    ["un bug", new TypeError("Cannot read properties of undefined")],
    ["nada", undefined],
  ])("no transitoria: %s", (_name, error) => {
    expect(isTransient(error)).toBe(false);
  });
});

describe("withRetry", () => {
  it("reintenta una falla transitoria con espera creciente y devuelve el resultado", async () => {
    const waits: number[] = [];
    const retries: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        if (++calls < 3) throw refused();
        return "ok";
      },
      { sleep: async (ms) => void waits.push(ms), random: () => 0.5, onRetry: (i) => retries.push(i.attempt) },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(waits).toEqual([200, 600]); // con random 0,5 la variación es cero
    expect(retries).toEqual([2, 3]);
  });

  it("la variación al azar queda dentro de ±25 %", async () => {
    const waits: number[] = [];
    await expect(withRetry(async () => Promise.reject(refused()), { sleep: async (ms) => void waits.push(ms), random: () => 1 })).rejects.toThrow();
    expect(waits).toEqual([250, 750]);
  });

  it("una falla no transitoria no se reintenta; si se agotan los intentos, lanza la última", async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new ToolUserError("dato inválido"); }, instant)).rejects.toThrow("dato inválido");
    expect(calls).toBe(1);
    calls = 0;
    await expect(withRetry(async () => { calls++; throw refused(); }, instant)).rejects.toThrow("ECONNREFUSED");
    expect(calls).toBe(3);
  });
});

describe("herramientas con reintentos (R1, R3)", () => {
  it("una herramienta que falla 2 veces contesta al tercer intento", async () => {
    let calls = 0;
    const run = safeTool("getStockLevels", async () => {
      if (++calls < 3) throw refused();
      return { items: [{ name: "Cera mate", stock: 31 }] };
    }, instant);
    expect(JSON.parse(await run({}))).toEqual({ items: [{ name: "Cera mate", stock: 31 }] });
    expect(calls).toBe(3);
  });

  it("si falla siempre, el modelo recibe el mensaje genérico: que ya se reintentó y que no invente", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = safeTool("listAppointments", async () => { throw refused(); }, instant);
    const error = await run({}).catch((e: Error) => e);
    expect(String(error)).toMatch(/problema del sistema/);
    expect(String(error)).toMatch(/Ya se reintentó 3 veces/);
    expect(String(error)).toMatch(/no lo inventes/);
    expect(String(error)).not.toMatch(/127\.0\.0\.1/); // el detalle no le llega al modelo
    spy.mockRestore();
  });

  it("un error esperable (dato inválido) no se reintenta y le llega tal cual al modelo", async () => {
    let calls = 0;
    const run = safeTool("findClient", async () => { calls++; throw new ToolUserError("No encontré a Juancho"); }, instant);
    await expect(run({})).rejects.toThrow("No encontré a Juancho");
    expect(calls).toBe(1);
  });

  it("dentro del grafo: el agente recibe el resultado bueno, sin enterarse de los reintentos", async () => {
    let calls = 0;
    const stock = tool(
      safeTool("getStockLevels", async () => {
        if (++calls < 3) throw refused();
        return { stock: 31 };
      }, instant),
      { name: "getStockLevels", description: "stock", schema: z.object({}) },
    );
    const { model, calls: modelCalls } = scriptedModel([toolCall("c1", "getStockLevels"), new AIMessage("Quedan 31.")]);
    const graph = buildTestGraph({ model, tools: [stock] });
    const result = await graph.invoke({ messages: [new HumanMessage("¿stock?")] });
    expect(result.messages.at(-1)!.text).toBe("Quedan 31.");
    expect(modelCalls[1]!.at(-1)!.text).toBe(JSON.stringify({ stock: 31 }));
    expect(calls).toBe(3);
  });
});

describe("secciones de reporte con reintentos (R1)", () => {
  it("la sección de stock se recupera de una caída de la base", async () => {
    let calls = 0;
    const db = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        if (++calls <= 2) throw refused(); // el primer intento hace dos consultas a la vez: fallan las dos
        return strings.join("").includes("COUNT(*)") ? [{ total: 1, lowCount: 0 }] : [{ id: 1, name: "Cera mate", sku: "CER-001", stock: 31, minStock: 5, isLow: false }];
      },
    } as unknown as Db;
    const part = await runSection("stock", "r1", { dateFrom: "2026-11-01", dateTo: "2026-11-07" }, db);
    expect(part).toMatchObject({ status: "ok", section: "stock" });
    expect(calls).toBe(4);
  });
});

describe("load_memory con retryPolicy de LangGraph (R4)", () => {
  it("si el Store falla 2 veces de forma transitoria, el turno sigue con las memorias", async () => {
    const store = new InMemoryStore();
    await saveMemory({ store, namespace: ["test", "retry"] }, { kind: "rule", text: "Los lunes no se agendan turnos." });
    // LangGraph envuelve el Store y le habla con `batch`: ahí se simula la caída.
    const batch = store.batch.bind(store);
    let calls = 0;
    store.batch = (async (...args: Parameters<typeof batch>) => {
      if (++calls < 3) throw refused();
      return batch(...args);
    }) as unknown as typeof store.batch;
    const { model, calls: modelCalls } = scriptedModel([new AIMessage("hola")]);
    const graph = buildTestGraph({ model, tools: [], intent: "chat", store, memoryNamespace: ["test", "retry"], checkpointer: new MemorySaver() });
    const result = await graph.invoke({ messages: [new HumanMessage("hola")] }, { configurable: { thread_id: "m" } });
    expect(calls).toBe(3);
    expect(result.businessContext).toHaveLength(1);
    expect(String(modelCalls[0]![0]!.content)).toMatch(/Los lunes no se agendan turnos/);
  });

  it("una falla que no es transitoria no se reintenta: el turno falla (no sigue sin las reglas)", async () => {
    const store = new InMemoryStore();
    let calls = 0;
    store.batch = (async () => {
      calls++;
      throw Object.assign(new Error("permission denied"), { code: "42501" });
    }) as unknown as typeof store.batch;
    const graph = buildTestGraph({ model: scriptedModel([]).model, tools: [], intent: "chat", store, checkpointer: new MemorySaver() });
    await expect(graph.invoke({ messages: [new HumanMessage("hola")] }, { configurable: { thread_id: "m2" } })).rejects.toThrow(/permission denied/);
    expect(calls).toBe(1);
  });
});

describe("reintentos de las llamadas al modelo (R4)", () => {
  it("LangChain los reintenta 3 veces (por defecto eran 6)", () => {
    const env = parseEnv({ ANTHROPIC_API_KEY: "sk-test", DATABASE_URL_READ: "x", DATABASE_URL_CHECKPOINTS: "x", DATABASE_URL_ACTIONS: "x" });
    expect((claude(env, env.MODEL_AGENT) as unknown as { caller: { maxRetries: number } }).caller.maxRetries).toBe(CLAUDE_MAX_RETRIES);
    expect(CLAUDE_MAX_RETRIES).toBe(3);
  });
});
