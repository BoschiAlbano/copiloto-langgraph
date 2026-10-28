import { loadEnvFile } from "../config/env.js";
import { ensureRoleLogin } from "./role-login.js";

// Asigna al rol de lectura el login y la contraseña que están en DATABASE_URL_READ.
loadEnvFile();
const adminUrl = process.env.DATABASE_URL_WRITE;
const roleUrl = process.env.DATABASE_URL_READ;
if (!adminUrl || !roleUrl) {
  console.error("Faltan DATABASE_URL_WRITE o DATABASE_URL_READ. Revisá tu archivo .env (ver .env.example).");
  process.exit(1);
}

try {
  const { roleName, status } = await ensureRoleLogin({ adminUrl, roleUrl, expectedRole: "copilot_reader" });
  console.log(status === "ready" ? `Rol ${roleName} ya está listo.` : `Rol ${roleName} configurado y listo para conectarse.`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
