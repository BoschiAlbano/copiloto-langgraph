import { AIMessage } from "@langchain/core/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { createPrisma, type Db } from "../../src/db/client.js";
import { makeActionRunner } from "../../src/graph/action-runner.js";
import { listBranches, switchBranch } from "../../src/graph/branches.js";
import { collectTurn, resumeTurn, streamRunTurn } from "../../src/graph/run-turn.js";
import { streamReplayTurn } from "../../src/graph/time-travel.js";
import type { UiEvent } from "../../src/web/events.js";
import { checkpointsUrl, openCheckpointing } from "../helpers/checkpointing.js";
import { buildTestGraph } from "../helpers/graph.js";
import { echoModel, scriptedModel, toolCall } from "../helpers/models.js";
import { TestThreads } from "../helpers/threads.js";
import { actionsUrl, hasWriteDb, readUrl, TEST_SKU, useWriteFixtures } from "./fixtures.js";

// Ramas del hilo (specs/ramas-del-hilo.md, CA4), con la base real y el checkpointer de Postgres: ir de una versión a
// otra no repite ni deshace una acción aprobada. Cambiar de rama mueve el estado del hilo, no la base del negocio.
describe.skipIf(!hasWriteDb || !checkpointsUrl)("cambiar de versión con una acción aprobada (base real)", () => {
  const fx = useWriteFixtures();
  const threads = new TestThreads();
  let readDb: Db;
  let actionsDb: Db;

  beforeAll(() => {
    loadEnv();
    readDb = createPrisma(readUrl!);
    actionsDb = createPrisma(actionsUrl!);
  });
  afterAll(async () => {
    await readDb.$disconnect();
    await actionsDb.$disconnect();
    const cp = openCheckpointing();
    await threads.cleanup(cp.saver);
    await cp.close();
  });

  it("aprobar, reintentar y rechazar; después ir y volver entre las versiones no cambia el stock ni el registro", async () => {
    const id = threads.fresh();
    const cp = openCheckpointing();
    const stockOf = async () => (await fx.sql.query(`SELECT stock FROM products WHERE sku = $1`, [TEST_SKU])).rows[0].stock as number;
    const logOf = async () => (await fx.sql.query(`SELECT decision FROM action_log WHERE thread_id = $1 ORDER BY id`, [id])).rows.map((r) => r.decision as string);
    const action = scriptedModel([
      toolCall("primera", "adjustStock", { sku: TEST_SKU, delta: 3, reason: "Llegó un pedido" }),
      new AIMessage("Listo: sumé 3."),
      toolCall("segunda", "adjustStock", { sku: TEST_SKU, delta: 3, reason: "Llegó un pedido" }),
      new AIMessage("No lo hice."),
    ]);
    const graph = buildTestGraph({
      model: echoModel().model,
      actionModel: action.model,
      tools: [],
      actions: makeActionRunner(readDb, actionsDb),
      intent: "action",
      checkpointer: cp.saver,
    });
    try {
      const before = await stockOf();
      const events: UiEvent[] = [];
      for await (const e of streamRunTurn({ graph }, id, "sumá 3 unidades")) events.push(e);
      const messageId = events[0]?.type === "turn" ? events[0].humanMessageId : "";
      await resumeTurn({ graph }, id, { decision: "approve" });
      const retried = await collectTurn(streamReplayTurn({ graph }, id, messageId));
      expect(retried.awaiting).toBeDefined();
      await resumeTurn({ graph }, id, { decision: "reject" });
      expect(await stockOf()).toBe(before + 3);
      expect(await logOf()).toEqual(["approved", "rejected"]);

      // Abrir la 1 (la que ejecutó), volver a la 2 y otra vez a la 1.
      const tipOf = async (version: number) => (await listBranches(graph, id)).branches.find((b) => b.version === version)!.tipId;
      expect((await listBranches(graph, id)).branches.map((b) => b.executedActions.length)).toEqual([1, 0]);
      expect((await switchBranch(graph, id, await tipOf(1))).leftActions).toEqual([]);
      const back = await switchBranch(graph, id, await tipOf(2));
      expect(back.leftActions, "dejar la 1 recuerda lo que ejecutó").toHaveLength(1);
      await switchBranch(graph, id, await tipOf(1));

      expect(await stockOf(), "el stock cambió una sola vez").toBe(before + 3);
      expect(await logOf(), "el registro no cambia al cambiar de versión").toEqual(["approved", "rejected"]);
      expect((await listBranches(graph, id)).branches.map((b) => [b.version, b.current])).toEqual([
        [1, true],
        [2, false],
      ]);
    } finally {
      await cp.close();
    }
  });
});
