import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { describeCheckpoint } from "../src/cli/format.js";
import { resumeTurn, runTurn } from "../src/graph/run-turn.js";
import { getHistory, getSubgraphHistory } from "../src/graph/threads.js";
import { fakeActions } from "./helpers/actions.js";
import { buildTestGraph, planned } from "./helpers/graph.js";
import { scriptedModel, toolCall } from "./helpers/models.js";

// CA9 (fase 7): la historia del hilo muestra el paso por el supervisor y los subgrafos; con --subgraphs, también los
// pasos de adentro de cada subgrafo.

const getStockLevels = tool(async () => JSON.stringify({ lowCount: 0 }), { name: "getStockLevels", description: "Stock", schema: z.strictObject({}) });

async function mixedThread() {
  const saver = new MemorySaver();
  const graph = buildTestGraph({
    model: scriptedModel([toolCall("q1", "getStockLevels"), new AIMessage("Quedan 11.")]).model,
    actionModel: scriptedModel([toolCall("toolu_1", "registerSale", { paymentMethod: "cash", items: [{ sku: "GEL-001", qty: 1 }] }), new AIMessage("Venta registrada.")]).model,
    tools: [getStockLevels],
    actions: fakeActions().runner,
    intent: planned(["action", "registrá la venta"], ["query", "decime el stock"]),
    checkpointer: saver,
  });
  await runTurn({ graph }, "hilo-historia", "registrá la venta y decime el stock");
  await resumeTurn({ graph }, "hilo-historia", { decision: "approve" });
  return { graph, saver };
}

describe("historia de un pedido mixto (CA9)", () => {
  it("la del grafo principal pasa por el supervisor entre agente y agente; cada subgrafo es un paso", async () => {
    const { graph } = await mixedThread();
    const ran = (await getHistory(graph as never, "hilo-historia")).reverse().map((c) => c.ranNodes.join("+"));
    // La pausa deja dos checkpoints sobre action_graph: el de la espera y el de la reanudación, que lo completa.
    expect(ran).toEqual(["", "__start__", "router", "supervisor", "action_graph", "supervisor", "query_graph", "supervisor"]);
  });

  it("con --subgraphs: una corrida por agente, en orden, con sus pasos internos", async () => {
    const { graph, saver } = await mixedThread();
    const runs = await getSubgraphHistory(graph as never, saver, "hilo-historia");
    expect(runs.map((r) => r.node)).toEqual(["action_graph", "query_graph"]);
    expect(runs[0]!.namespace).toMatch(/^action_graph:/);

    const inner = (i: number) => [...runs[i]!.checkpoints].reverse().map((c) => c.ranNodes.join("+")).filter(Boolean);
    // La aprobación pausó DENTRO del subgrafo de acciones y siguió ahí mismo al decidir.
    expect(inner(0)).toEqual(["__start__", "action_agent", "propose_action", "await_approval", "execute_action", "action_agent"]);
    expect(inner(1)).toEqual(["__start__", "agent", "tools", "agent"]);
    expect(describeCheckpoint(runs[1]!.checkpoints[0]!)).toContain("corrió agent");
  });

  it("un hilo sin subgrafos (charla) no tiene corridas", async () => {
    const saver = new MemorySaver();
    const graph = buildTestGraph({ model: scriptedModel([new AIMessage("¡Hola!")]).model, tools: [], intent: "chat", checkpointer: saver });
    await runTurn({ graph }, "hilo-charla", "hola");
    expect(await getSubgraphHistory(graph as never, saver, "hilo-charla")).toEqual([]);
  });
});
