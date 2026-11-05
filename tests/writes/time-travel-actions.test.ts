import { AIMessage } from "@langchain/core/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { createPrisma, type Db } from "../../src/db/client.js";
import { makeActionRunner } from "../../src/graph/action-runner.js";
import { collectTurn, resumeTurn, streamRunTurn } from "../../src/graph/run-turn.js";
import { getStatus } from "../../src/graph/threads.js";
import { streamReplayTurn } from "../../src/graph/time-travel.js";
import type { UiEvent } from "../../src/web/events.js";
import { checkpointsUrl, openCheckpointing } from "../helpers/checkpointing.js";
import { buildTestGraph } from "../helpers/graph.js";
import { echoModel, scriptedModel, toolCall } from "../helpers/models.js";
import { TestThreads } from "../helpers/threads.js";
import { actionsUrl, hasWriteDb, readUrl, TEST_SKU, useWriteFixtures } from "./fixtures.js";

// Fase 10 (R13, CA4): el viaje en el tiempo con la base real. Reintentar un turno cuya acción ya se aprobó produce una
// propuesta nueva que hay que aprobar; y si la propuesta es la MISMA acción (mismo id), no se ejecuta dos veces.
describe.skipIf(!hasWriteDb || !checkpointsUrl)("viaje en el tiempo sobre una acción aprobada (base real)", () => {
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

  it("reintentar no ejecuta nada sin aprobar, y la misma acción aprobada otra vez se aplica una sola vez", async () => {
    const id = threads.fresh();
    const cp = openCheckpointing();
    const stockOf = async () => (await fx.sql.query(`SELECT stock FROM products WHERE sku = $1`, [TEST_SKU])).rows[0].stock as number;
    const logOf = async () => (await fx.sql.query(`SELECT decision FROM action_log WHERE thread_id = $1`, [id])).rows.map((r) => r.decision as string);
    // El modelo falso propone exactamente la misma llamada (mismo id) las dos veces: la misma acción.
    const same = toolCall("igual", "adjustStock", { sku: TEST_SKU, delta: 4, reason: "Llegó un pedido" });
    const action = scriptedModel([same, new AIMessage("Listo."), same, new AIMessage("Listo de nuevo.")]);
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
      for await (const e of streamRunTurn({ graph }, id, "sumá 4 unidades")) events.push(e);
      const messageId = events[0]?.type === "turn" ? events[0].humanMessageId : "";
      await resumeTurn({ graph }, id, { decision: "approve" });
      expect(await stockOf()).toBe(before + 4);
      expect(await logOf()).toEqual(["approved"]);

      // Reintentar: la rama nueva propone de nuevo y se pausa. Nada cambia en la base sin aprobar.
      const retried = await collectTurn(streamReplayTurn({ graph }, id, messageId));
      expect(retried.awaiting?.action.params).toMatchObject({ delta: 4 });
      expect(await stockOf()).toBe(before + 4);

      // Aprobar la MISMA acción (mismo id): la clave de la fase 5 la frena.
      await resumeTurn({ graph }, id, { decision: "approve" });
      expect(await stockOf()).toBe(before + 4);
      expect(await logOf()).toEqual(["approved"]);
      expect((await getStatus(graph, id)).pending).toBe(false);
    } finally {
      await cp.close();
    }
  });
});
