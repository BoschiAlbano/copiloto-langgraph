import { randomBytes } from "node:crypto";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { deleteThread } from "../../src/graph/threads.js";
import type { TraceStore } from "../../src/observability/store.js";

/** Ids de hilo únicos para un test, que se borran de la base al terminar. */
export class TestThreads {
  private readonly ids: string[] = [];

  fresh(prefix = "test"): string {
    const id = `${prefix}-${randomBytes(4).toString("hex")}`;
    this.ids.push(id);
    return id;
  }

  /** Borra los hilos y, si se pasa dónde están, sus trazas (fase 11: los turnos del agente real dejan trazas). */
  async cleanup(saver: Pick<BaseCheckpointSaver, "deleteThread">, traces?: Pick<TraceStore, "deleteThread">) {
    for (const id of this.ids.splice(0)) {
      await deleteThread(saver, id);
      await traces?.deleteThread(id);
    }
  }
}
