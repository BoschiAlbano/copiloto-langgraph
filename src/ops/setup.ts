import { existsSync } from "node:fs";
import pg from "pg";
import { loadEnvFile, parseEnv } from "../config/env.js";
import { fail, hasDocker, hasEnvFile, isBundledDb, nodeMajor, run, startBundledDb } from "./common.js";

// `npm run setup` (fase 12, R2): la primera vez, de un clon limpio a una base lista con los datos de prueba.
// Se puede volver a correr: no borra nada (los datos de prueba se cargan solo si la base está vacía).

console.log("Preparando el copiloto…\n");

if (nodeMajor() < 24) fail(`Hace falta Node 24 o más nuevo (tenés ${process.versions.node}).`);
if (!hasEnvFile()) fail("No hay archivo .env. Copiá .env.example a .env y poné tu ANTHROPIC_API_KEY:\n  Copy-Item .env.example .env");
loadEnvFile();
let env;
try {
  env = parseEnv(process.env);
} catch (error) {
  fail((error as Error).message);
}
const adminUrl = process.env.DATABASE_URL_WRITE;
if (!adminUrl) fail("Falta DATABASE_URL_WRITE en .env (la usa la preparación de la base; ver .env.example).");

const bundled = isBundledDb(adminUrl);
if (bundled) {
  if (!process.env.POSTGRES_PASSWORD) fail("Falta POSTGRES_PASSWORD en .env: es la contraseña del dueño de la base propia (ver .env.example).");
  if (!hasDocker()) fail("Docker no responde. Abrí Docker Desktop y volvé a correr `npm run setup`.");
  console.log("▸ Base propia (Postgres 17, puerto 54329)");
  await startBundledDb().catch((error: Error) => fail(error.message));
} else {
  console.log(`▸ Base externa (${new URL(adminUrl).host}): se usa la que ya está corriendo.`);
}

const steps: [string, string, string[]][] = [
  ["Cliente de la base (Prisma)", "npx", ["prisma", "generate"]],
  ["Migraciones", "npx", ["prisma", "migrate", "deploy"]],
  ["Roles de lectura y de acciones", "npx", ["tsx", "src/db/roles.ts"]],
  ["Esquema de hilos y memoria", "npx", ["tsx", "src/db/checkpoints.ts"]],
  ["Esquema de trazas y evaluaciones", "npx", ["tsx", "src/db/observability.ts"]],
];
for (const [label, command, args] of steps) {
  console.log(`\n▸ ${label}`);
  if (!run(command, args)) fail(`Falló: ${label} (\`${command} ${args.join(" ")}\`).`);
}

// Los datos de prueba, solo si la base no tiene clientes: volver a correr setup no pisa lo que ya hay.
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const { rows } = await admin.query("SELECT COUNT(*)::int AS n FROM clients");
await admin.end();
if (rows[0].n === 0) {
  console.log("\n▸ Datos de prueba");
  if (!run("npx", ["tsx", "src/db/seed.ts"])) fail("Falló la carga de los datos de prueba (`npm run db:seed`).");
} else console.log(`\n▸ Datos de prueba: la base ya tiene ${rows[0].n} clientes, no se tocan.`);

if (!existsSync("web/node_modules")) {
  console.log("\n▸ Dependencias de la web");
  if (!run("npm", ["--prefix", "web", "install"])) fail("Falló `npm --prefix web install`.");
}

void env;
console.log("\n✓ Listo. Para usarlo: npm run start   (la web queda en http://127.0.0.1:3000)");
