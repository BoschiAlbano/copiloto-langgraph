import { randomBytes } from "node:crypto";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { deleteThread } from "../../src/graph/threads.js";

/** Ids de hilo únicos para un test, que se borran de la base al terminar. */
export class TestThreads {
  private readonly ids: string[] = [];

  fresh(prefix = "test"): string {
    const id = `${prefix}-${randomBytes(4).toString("hex")}`;
    this.ids.push(id);
    return id;
  }

  async cleanup(saver: Pick<BaseCheckpointSaver, "deleteThread">) {
    for (const id of this.ids.splice(0)) await deleteThread(saver, id);
  }
}
