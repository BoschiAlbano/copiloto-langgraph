import { loadEnv } from "../config/env.js";
import { clearMemories, createMemoryStore, deleteMemory, listMemories, MEMORY_NAMESPACE } from "../memory/store.js";
import { describeMemoryRow } from "./format.js";

// La memoria de largo plazo desde la terminal (fase 8), sin modelo:
// npm run memory                        → lista las memorias
// npm run memory -- delete <id>         → borra una
// npm run memory -- clear --yes         → borra todas (sin --yes solo dice cuántas borraría)
const USAGE = "Uso: npm run memory [-- delete <id> | -- clear --yes]";
const args = process.argv.slice(2);
const [command = "list", id] = args.filter((a) => a !== "--yes");

let env;
try {
  env = loadEnv();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const store = createMemoryStore(env.DATABASE_URL_CHECKPOINTS);
const bank = { store, namespace: MEMORY_NAMESPACE };
let exitCode = 0;
try {
  if (command === "list") {
    const memories = await listMemories(bank);
    if (memories.length === 0) console.log("No hay memorias anotadas. Se anotan desde el chat («acordate de que…»).");
    else {
      console.log(`Memorias anotadas (${memories.length}), de la más vieja a la más nueva:\n`);
      console.log("id      tipo         anotada       texto");
      for (const m of memories) console.log(describeMemoryRow(m));
      console.log("\nBorrar una: npm run memory -- delete <id>");
    }
  } else if (command === "delete") {
    if (!id) throw new Error(`Falta el id de la memoria. ${USAGE}`);
    const deleted = await deleteMemory(bank, id);
    if (!deleted) throw new Error(`No hay ninguna memoria con id ${id}. Mirá la lista con: npm run memory`);
    console.log(`Memoria ${id} borrada: «${deleted.text}»`);
  } else if (command === "clear") {
    if (!args.includes("--yes")) {
      const count = (await listMemories(bank)).length;
      console.log(`Esto borraría las ${count} memorias anotadas. Para hacerlo: npm run memory -- clear --yes`);
    } else console.log(`Memorias borradas: ${await clearMemories(bank)}.`);
  } else {
    throw new Error(`Comando desconocido: ${command}. ${USAGE}`);
  }
} catch (error) {
  console.error((error as Error).message);
  exitCode = 1;
} finally {
  await store.stop();
}
process.exit(exitCode);
