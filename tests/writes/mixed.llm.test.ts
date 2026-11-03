import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { createAgent, type Agent } from "../../src/graph/create-agent.js";
import { getSubgraphHistory } from "../../src/graph/threads.js";
import { resumeTurn, runTurn } from "../../src/graph/run-turn.js";
import { TestThreads } from "../helpers/threads.js";
import { hasWriteDb, TEST_SKU, useWriteFixtures } from "./fixtures.js";

// CA2 completo (fase 7), con el modelo real y la base: un pedido mixto pasa por el agente de acciones y después por el
// de consultas, y la consulta ve el stock DESPUÉS de la venta. Usa el producto de prueba (TST-001, 20 unidades), no
// uno del seed: la venta se aprueba de verdad y la limpieza la borra al terminar.
// Con el modelo real (centavos de API): solo corre si se pide.   $env:RUN_LLM_TESTS = "1"; npm test
const enabled = process.env.RUN_LLM_TESTS === "1" && hasWriteDb;

describe.skipIf(!enabled)("pedido mixto con el modelo real y la base (CA2)", () => {
  const fx = useWriteFixtures();
  const threads = new TestThreads();
  let agent: Agent;
  beforeAll(() => {
    agent = createAgent(loadEnv());
  });
  afterAll(async () => {
    await threads.cleanup(agent.checkpointer);
    await agent.close();
  });

  const stockOf = async () => (await fx.sql.query(`SELECT stock FROM products WHERE sku = $1`, [TEST_SKU])).rows[0].stock as number;

  it("registra la venta (aprobando) y la respuesta informa el stock que quedó, igual al de la base", async () => {
    const id = threads.fresh("test");
    const before = await stockOf();
    const paused = await runTurn(agent, id, `Registrá la venta de un TST Producto (${TEST_SKU}) en efectivo y decime cuánto stock queda.`);

    expect(paused.route.tasks?.map((t) => t.intent)).toEqual(["action", "query"]);
    expect(paused.awaiting?.action.tool).toBe("registerSale");
    expect(await stockOf()).toBe(before); // nada se escribe antes de aprobar

    const done = await resumeTurn(agent, id, { decision: "approve" });
    const after = await stockOf();
    expect(after).toBe(before - 1);
    // La consulta corrió después de la venta: informa el stock nuevo (y no el anterior).
    expect(done.reply, done.reply).toMatch(new RegExp(`\\b${after}\\b`));
    expect(done.summary.toolCalls.some((c) => c.name === "getStockLevels"), JSON.stringify(done.summary.toolCalls)).toBe(true);

    // Pasó por los dos agentes, en ese orden.
    const runs = await getSubgraphHistory(agent.graph, agent.checkpointer, id);
    expect(runs.map((r) => r.node)).toEqual(["action_graph", "query_graph"]);
  }, 180_000);

  it("si se rechaza la venta, la consulta se hace igual y el stock no cambia (CA7)", async () => {
    const id = threads.fresh("test");
    const before = await stockOf();
    const paused = await runTurn(agent, id, `Registrá la venta de un TST Producto (${TEST_SKU}) en efectivo y decime cuánto stock queda.`);
    expect(paused.awaiting?.action.tool).toBe("registerSale");

    const done = await resumeTurn(agent, id, { decision: "reject", comment: "todavía no" });
    expect(await stockOf()).toBe(before);
    expect(done.reply, done.reply).toMatch(new RegExp(`\\b${before}\\b`));
  }, 180_000);
});
