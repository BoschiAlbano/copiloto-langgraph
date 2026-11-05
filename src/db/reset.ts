import { execSync } from "node:child_process";
import pg from "pg";
import { loadEnvFile } from "../config/env.js";

// Recrea SOLO las tablas del negocio (y el control de migraciones de Prisma) en `public`.
// No borra el esquema entero: Supabase guarda ahí permisos y otras cosas propias.
const DROP_SQL = `
  DROP TABLE IF EXISTS "sale_items", "sales", "appointments", "action_log",
                       "products", "services", "staff", "clients", "_prisma_migrations" CASCADE;
  DROP TYPE IF EXISTS "AppointmentStatus", "PaymentMethod";
  -- Los hilos guardados hablan de datos del seed, que cambian: se borran con ellos.
  DROP SCHEMA IF EXISTS langgraph CASCADE;
  -- Las trazas y las corridas de evaluación también hablan de esos hilos (fase 11).
  DROP SCHEMA IF EXISTS observability CASCADE;
`;

loadEnvFile();
const url = process.env.DATABASE_URL_WRITE;
if (!url) {
  console.error("Falta la variable de entorno DATABASE_URL_WRITE. Revisá tu archivo .env (ver .env.example).");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(DROP_SQL);
  console.log("Tablas del negocio eliminadas.");
} finally {
  await client.end();
}

execSync("npx prisma migrate deploy", { stdio: "inherit" });
execSync("npx tsx src/db/roles.ts", { stdio: "inherit" });
execSync("npx tsx src/db/checkpoints.ts", { stdio: "inherit" });
execSync("npx tsx src/db/observability.ts", { stdio: "inherit" });
execSync("npx tsx src/db/seed.ts", { stdio: "inherit" });
