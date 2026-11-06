import { statSync } from "node:fs";
import { loadEnvFile } from "../config/env.js";
import { backup, backupContainer, KEEP_BACKUPS, pruneBackups } from "./backup-core.js";
import { fail, hasDocker } from "./common.js";
import { log } from "./log.js";

// `npm run db:backup` (fase 12, R9): un respaldo de los esquemas del copiloto en backups/, y quedan los últimos 10.
loadEnvFile();
if (!hasDocker()) fail("Docker no responde: abrí Docker Desktop (la base corre ahí).");
let container: string;
try {
  container = backupContainer();
} catch (error) {
  fail((error as Error).message);
}
try {
  const file = await backup(container);
  const removed = pruneBackups();
  const mb = (statSync(file).size / 1024 / 1024).toFixed(1);
  log.info("respaldo", { file, mb: Number(mb), container });
  console.log(`✓ Respaldo en ${file} (${mb} MB).${removed.length ? ` Se borraron ${removed.length} viejos: quedan los últimos ${KEEP_BACKUPS}.` : ""}`);
} catch (error) {
  log.error("respaldo-fallo", (error as Error).message, { container });
  fail(`No se pudo hacer el respaldo: ${(error as Error).message}`);
}
