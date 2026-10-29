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
