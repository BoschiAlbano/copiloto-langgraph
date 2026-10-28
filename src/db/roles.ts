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

const client = new pg.Client({ connectionString: writeUrl });
await client.connect();
try {
  await client.query(
    `ALTER ROLE ${client.escapeIdentifier(roleName)} LOGIN PASSWORD ${client.escapeLiteral(password)}`,
  );
  console.log(`Rol ${roleName} listo para conectarse.`);
} finally {
  await client.end();
}
