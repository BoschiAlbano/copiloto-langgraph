import pg from "pg";
import { loadEnvFile } from "../config/env.js";
import { ensureRoleLogin } from "./role-login.js";

// Asigna a los roles de la aplicación el login y la contraseña que están en .env:
//   copilot_reader  ← DATABASE_URL_READ     (solo lectura; consultas)
//   copilot_actions ← DATABASE_URL_ACTIONS  (escritura acotada; acciones aprobadas)
// (copilot_checkpointer lo prepara `npm run db:checkpoints`.)
loadEnvFile();
const adminUrl = process.env.DATABASE_URL_WRITE;
const roles = [
  { variable: "DATABASE_URL_READ", expectedRole: "copilot_reader" },
  { variable: "DATABASE_URL_ACTIONS", expectedRole: "copilot_actions" },
] as const;

const missing = [adminUrl ? null : "DATABASE_URL_WRITE", ...roles.map((r) => (process.env[r.variable] ? null : r.variable))].filter(Boolean);
if (!adminUrl || missing.length > 0) {
  console.error(`Faltan variables de entorno: ${missing.join(", ")}. Revisá tu archivo .env (ver .env.example).`);
  process.exit(1);
}

for (const { variable, expectedRole } of roles) {
  try {
    const { roleName, status } = await ensureRoleLogin({ adminUrl, roleUrl: process.env[variable]!, expectedRole });
    console.log(status === "ready" ? `Rol ${roleName} ya está listo.` : `Rol ${roleName} configurado y listo para conectarse.`);
  } catch (error) {
    console.error(`${variable}: ${(error as Error).message}`);
    process.exit(1);
  }
}

// Fase 12 (R6): ninguna consulta de la aplicación tarda más de 10 s. Vale para cada sesión nueva de estos roles, también
// por el pooler de Supabase. Una consulta cortada (código 57014) no es transitoria: la herramienta la informa como falla.
const STATEMENT_TIMEOUT = "10s";
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
try {
  for (const { expectedRole } of roles) {
    await admin.query(`ALTER ROLE ${admin.escapeIdentifier(expectedRole)} SET statement_timeout = ${admin.escapeLiteral(STATEMENT_TIMEOUT)}`);
  }
  console.log(`Límite de ${STATEMENT_TIMEOUT} por consulta para ${roles.map((r) => r.expectedRole).join(" y ")}.`);
} finally {
  await admin.end();
}
