import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile, parseEnv } from "../config/env.js";
import { fail, hasDocker, hasEnvFile, isBundledDb, run, startBundledDb } from "./common.js";

// `npm run start` (fase 12, R2): levanta la base si es la propia y sirve la web en modo producción.

if (!hasEnvFile()) fail("No hay archivo .env. Corré primero `npm run setup` (ver el README).");
loadEnvFile();
try {
  parseEnv(process.env);
} catch (error) {
  fail((error as Error).message);
}

if (isBundledDb(process.env.DATABASE_URL_WRITE ?? process.env.DATABASE_URL_CHECKPOINTS)) {
  if (!hasDocker()) fail("Docker no responde. Abrí Docker Desktop y volvé a correr `npm run start`.");
  await startBundledDb().catch((error: Error) => fail(error.message));
}

/** La fecha de modificación más nueva de los archivos de una carpeta (sin node_modules ni .next). */
function newest(dir: string): number {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
}

// El build de producción, si no existe o si cambió el código (la web compila también src/).
const buildId = "web/.next/BUILD_ID";
const stale = !existsSync(buildId) || Math.max(newest("src"), newest("web")) > statSync(buildId).mtimeMs;
if (stale) {
  console.log("▸ Compilando la web (el código cambió desde el último build)…");
  if (!run("npm", ["run", "web:build"])) fail("Falló el build de la web (`npm run web:build`).");
}

console.log("\n▸ Copiloto en http://127.0.0.1:3000  (Ctrl+C para parar la web; `npm run stop` para la base)\n");
run("npm", ["--prefix", "web", "run", "start"]);
