import { loadEnv } from "../config/env.js";
import { createAgent } from "../graph/create-agent.js";
import { parseThreadId } from "../graph/thread-id.js";
import { deleteThread, getHistory, getStatus, listThreads } from "../graph/threads.js";
import { describeCheckpoint, describeThread } from "./format.js";

// npm run threads                       → lista los hilos recientes
// npm run threads -- history <id>       → historia de checkpoints de un hilo (del más nuevo al más viejo)
// npm run threads -- delete <id>        → borra un hilo
const USAGE = "Uso: npm run threads [-- history <id> | -- delete <id>]";
const [command = "list", rawId] = process.argv.slice(2);

let env;
try {
  env = loadEnv();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const agent = createAgent(env);
let exitCode = 0;
try {
  if (command === "list") {
    const threads = await listThreads(agent);
    if (threads.length === 0) console.log("No hay hilos guardados todavía. Empezá uno con: npm run chat");
    else {
      console.log(`Hilos recientes (${threads.length}), del más nuevo al más viejo:\n`);
      for (const t of threads) console.log(`  ${describeThread(t)}`);
      console.log("\nRetomar uno: npm run chat <id>");
    }
  } else if (command === "history" || command === "delete") {
    if (!rawId) throw new Error(`Falta el id del hilo. ${USAGE}`);
    const id = parseThreadId(rawId);
    if (command === "history") {
      const status = await getStatus(agent.graph, id);
      if (!status.exists) throw new Error(`No existe el hilo ${id}.`);
      const history = await getHistory(agent.graph, id);
      console.log(`Hilo ${id}: ${history.length} checkpoints${status.awaiting ? " (⏸ espera tu aprobación)" : status.pending ? " (⚠ a medias)" : ""}, del más nuevo al más viejo:\n`);
      console.log("paso  origen corrió        sigue         msj  ruta                 id");
      for (const c of history) console.log(`  ${describeCheckpoint(c)}`);
    } else {
      if (!(await getStatus(agent.graph, id)).exists) throw new Error(`No existe el hilo ${id}.`);
      await deleteThread(agent.checkpointer, id);
      console.log(`Hilo ${id} borrado.`);
    }
  } else {
    throw new Error(`Comando desconocido: ${command}. ${USAGE}`);
  }
} catch (error) {
  console.error((error as Error).message);
  exitCode = 1;
} finally {
  await agent.close();
}
process.exit(exitCode);
