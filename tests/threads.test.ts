import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runTurn } from "../src/graph/run-turn.js";
import { deleteThread, FIRST_MESSAGE_CHARS, getHistory, getStatus, listThreads } from "../src/graph/threads.js";
import { checkpointsUrl, openCheckpointing } from "./helpers/checkpointing.js";
import { buildTestGraph } from "./helpers/graph.js";
import { echoModel } from "./helpers/models.js";
import { TestThreads } from "./helpers/threads.js";

const threads = new TestThreads();

describe.skipIf(!checkpointsUrl)("listado y borrado de hilos", () => {
  const cp = openCheckpointing();
  const graph = buildTestGraph({ model: echoModel().model, tools: [], intent: "chat", checkpointer: cp.saver });
  afterAll(async () => {
    await threads.cleanup(cp.saver);
    await cp.close();
  });

  describe("CA6: listThreads", () => {
    const [oldest, middle, newest] = [threads.fresh("lista"), threads.fresh("lista"), threads.fresh("lista")];
    const long = `Quiero saber ${"muchísimas ".repeat(30)}cosas`;

    beforeAll(async () => {
      await runTurn({ graph }, oldest, "Primero de todos");
      await sleep(20);
      await runTurn({ graph }, middle, long);
      await runTurn({ graph }, middle, "segundo mensaje");
      await sleep(20);
      await runTurn({ graph }, newest, "El más reciente");
    });

    it("devuelve los hilos del más reciente al más viejo", async () => {
      const mine = (await listThreads({ pool: cp.pool, graph }, 200)).filter((t) => t.threadId.startsWith("lista-"));
      // La actividad de `middle` (dos turnos) es posterior a la de `oldest` y anterior a la de `newest`.
      expect(mine.map((t) => t.threadId)).toEqual([newest, middle, oldest]);
      for (let i = 1; i < mine.length; i++) {
        expect(mine[i - 1]!.lastActivity.getTime()).toBeGreaterThanOrEqual(mine[i]!.lastActivity.getTime());
      }
    });

    it("informa cantidad de mensajes, primer mensaje recortado y si quedó a medias", async () => {
      const all = await listThreads({ pool: cp.pool, graph }, 200);
      const byId = new Map(all.map((t) => [t.threadId, t]));

      expect(byId.get(oldest)).toMatchObject({ messageCount: 2, firstMessage: "Primero de todos", pending: false });
      expect(byId.get(middle)!.messageCount).toBe(4);
      expect(byId.get(middle)!.checkpoints).toBeGreaterThan(byId.get(oldest)!.checkpoints);
      const clipped = byId.get(middle)!.firstMessage;
      expect(clipped).toHaveLength(FIRST_MESSAGE_CHARS);
      expect(clipped.endsWith("…")).toBe(true);
      expect(clipped.startsWith("Quiero saber muchísimas")).toBe(true);
    });

    it("respeta el límite y por defecto no devuelve más de 20", async () => {
      expect(await listThreads({ pool: cp.pool, graph }, 1)).toHaveLength(1);
      expect((await listThreads({ pool: cp.pool, graph })).length).toBeLessThanOrEqual(20);
    });
  });

  describe("CA8: deleteThread", () => {
    const tables = ["checkpoints", "checkpoint_blobs", "checkpoint_writes"];
    const countRows = async (id: string) => {
      const out: Record<string, number> = {};
      for (const table of tables) {
        const { rows } = await cp.pool.query(`SELECT COUNT(*)::int AS n FROM langgraph.${table} WHERE thread_id = $1`, [id]);
        out[table] = rows[0].n;
      }
      return out;
    };

    it("quita el hilo de las tres tablas y no toca a los demás", async () => {
      const [doomed, kept] = [threads.fresh("borrar"), threads.fresh("borrar")];
      await runTurn({ graph }, doomed, "me van a borrar");
      await runTurn({ graph }, kept, "yo me quedo");

      const before = await countRows(doomed);
      for (const table of tables) expect(before[table], table).toBeGreaterThan(0);
      const keptBefore = await countRows(kept);

      await deleteThread(cp.saver, doomed);

      expect(await countRows(doomed)).toEqual({ checkpoints: 0, checkpoint_blobs: 0, checkpoint_writes: 0 });
      expect(await countRows(kept)).toEqual(keptBefore);
      expect((await getStatus(graph, doomed)).exists).toBe(false);
      expect((await getStatus(graph, kept)).messages).toHaveLength(2);
    });

    it("borrar un hilo que no existe no falla", async () => {
      await expect(deleteThread(cp.saver, threads.fresh("nada"))).resolves.toBeUndefined();
    });
  });
});

describe("CA7: un id inválido se rechaza sin tocar la base", () => {
  const bad = ["", "x".repeat(65), "con espacio", "a'b", "a;b", "a\nb", "ñandú", "'; DROP TABLE langgraph.checkpoints; --"];

  it("deleteThread, getStatus y getHistory no llegan a la base", async () => {
    const saver = { deleteThread: vi.fn() };
    const graph = { getState: vi.fn(), getStateHistory: vi.fn() };
    for (const id of bad) {
      await expect(deleteThread(saver, id), id).rejects.toThrow(/1 a 64 caracteres/);
      await expect(getStatus(graph, id), id).rejects.toThrow(/1 a 64 caracteres/);
      await expect(getHistory(graph, id), id).rejects.toThrow(/1 a 64 caracteres/);
      await expect(runTurn({ graph: graph as never }, id, "hola"), id).rejects.toThrow(/1 a 64 caracteres/);
    }
    expect(saver.deleteThread).not.toHaveBeenCalled();
    expect(graph.getState).not.toHaveBeenCalled();
    expect(graph.getStateHistory).not.toHaveBeenCalled();
  });
});
