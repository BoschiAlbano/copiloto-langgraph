import { existsSync } from "node:fs";
import { loadEnvFile } from "../config/env.js";
import { backup, backupContainer, inventory, restore } from "./backup-core.js";
import { fail, hasDocker, run } from "./common.js";
import { log } from "./log.js";

// `npm run db:restore -- <archivo> --yes` (fase 12, R10): reemplaza los esquemas del copiloto por los de un respaldo.
// Sin --yes, dice qué va a reemplazar y no hace nada. Antes de restaurar, respalda lo actual por si acaso.
loadEnvFile();
const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
const confirmed = process.argv.includes("--yes");
if (!file) fail("Falta el archivo: npm run db:restore -- backups/copiloto-….dump --yes");
if (!existsSync(file)) fail(`No existe ${file}.`);
if (!hasDocker()) fail("Docker no responde: abrí Docker Desktop (la base corre ahí).");
let container: string;
try {
  container = backupContainer();
} catch (error) {
  fail((error as Error).message);
}

if (!confirmed) {
  console.log(`Esto reemplaza los esquemas del copiloto (public, langgraph, observability) de la base de ${container} por los de ${file}.`);
  console.log(`Ahora hay:\n${inventory(container)}`);
  console.log("\nParás antes la web y la terminal (`Ctrl+C`). Para seguir, repetí el comando con --yes.");
  process.exit(0);
}

try {
  const safety = await backup(container, { label: "antes-de-restaurar" });
  console.log(`▸ Respaldo de lo actual, por si acaso: ${safety}`);
  await restore(container, file);
  log.info("restauracion", { file, container, safety });
  console.log(`✓ Restaurado ${file}.\n${inventory(container)}\n`);
} catch (error) {
  log.error("restauracion-fallo", (error as Error).message, { file, container });
  fail(`No se pudo restaurar (no se cambió nada): ${(error as Error).message}`);
}

console.log("▸ Revisión (npm run doctor)");
run("npx", ["tsx", "src/ops/doctor.ts"]);
