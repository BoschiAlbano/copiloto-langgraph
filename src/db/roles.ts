import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { loadEnvFile } from "../config/env.js";

// Asigna al rol de lectura el login y la contraseña que están en DATABASE_URL_READ,
// así el secreto vive solo en .env. Se conecta con el rol de escritura (postgres).
loadEnvFile();
const writeUrl = process.env.DATABASE_URL_WRITE;
const readUrl = process.env.DATABASE_URL_READ;
if (!writeUrl || !readUrl) {
  console.error("Faltan DATABASE_URL_WRITE o DATABASE_URL_READ. Revisá tu archivo .env (ver .env.example).");
  process.exit(1);
}

// El usuario del pooler es "<rol>.<tenant>": el rol es lo que va antes del primer punto.
const read = new URL(readUrl);
const roleName = decodeURIComponent(read.username).split(".")[0]!;
const password = decodeURIComponent(read.password);
if (roleName !== "copilot_reader" || !password) {
  console.error("DATABASE_URL_READ debe usar el usuario copilot_reader.<tenant> y tener contraseña.");
  process.exit(1);
}

/** ¿Puede el rol entrar por el pooler con la contraseña de .env? */
async function canLogin() {
  const client = new pg.Client({ connectionString: readUrl });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/** El pooler puede aceptar una conexión con credenciales en caché aunque el rol ya no pueda entrar: se mira también la base. */
async function roleHasLogin(client: pg.Client) {
  const { rows } = await client.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [roleName]);
  return rows[0]?.rolcanlogin === true;
}

// ALTER ROLE ... PASSWORD regenera el secreto del rol y el pooler guarda credenciales en caché:
// durante unos instantes algunas conexiones nuevas fallan. Por eso solo se toca si hace falta.
const admin = new pg.Client({ connectionString: writeUrl });
await admin.connect();
const hasLogin = await roleHasLogin(admin).finally(() => admin.end());

if (hasLogin && (await canLogin())) {
  console.log(`Rol ${roleName} ya está listo.`);
} else {
  const client = new pg.Client({ connectionString: writeUrl });
  await client.connect();
  try {
    await client.query(
      `ALTER ROLE ${client.escapeIdentifier(roleName)} LOGIN PASSWORD ${client.escapeLiteral(password)}`,
    );
  } finally {
    await client.end();
  }

  // Esperar a que el pooler acepte las credenciales nuevas.
  let ready = false;
  for (let attempt = 0; attempt < 15 && !ready; attempt++) {
    ready = await canLogin();
    if (!ready) await sleep(1000);
  }
  if (!ready) {
    console.error(`El rol ${roleName} se configuró, pero el pooler todavía no acepta la contraseña.`);
    process.exit(1);
  }
  console.log(`Rol ${roleName} configurado y listo para conectarse.`);
}
