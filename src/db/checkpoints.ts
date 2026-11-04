import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import pg from "pg";
import { loadEnvFile } from "../config/env.js";
import { CHECKPOINT_SCHEMA } from "../graph/checkpointing.js";
import { ensureRoleLogin } from "./role-login.js";

// Prepara dónde LangGraph guarda los hilos, con el dueño de la base (DATABASE_URL_WRITE):
//   1. crea el rol copilot_checkpointer (sin login todavía) y el esquema `langgraph`;
//   2. corre setup() del paquete: crea las tablas y aplica sus migraciones internas (las del checkpointer y, desde la
//      fase 8, las del Store de memoria de largo plazo, en el mismo esquema);
//   3. da al rol solo lectura y escritura de datos sobre esas tablas, y se lo quita a todos los demás;
//   4. le asigna el login y la contraseña de DATABASE_URL_CHECKPOINTS.
// Es idempotente. Se vuelve a correr al actualizar @langchain/langgraph-checkpoint-postgres.
const ROLE = "copilot_checkpointer";

loadEnvFile();
const adminUrl = process.env.DATABASE_URL_WRITE;
const roleUrl = process.env.DATABASE_URL_CHECKPOINTS;
if (!adminUrl || !roleUrl) {
  console.error("Faltan DATABASE_URL_WRITE o DATABASE_URL_CHECKPOINTS. Revisá tu archivo .env (ver .env.example).");
  process.exit(1);
}

const schema = `"${CHECKPOINT_SCHEMA}"`;

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
try {
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
        CREATE ROLE ${ROLE} NOLOGIN NOINHERIT;
      END IF;
    END $$;
    CREATE SCHEMA IF NOT EXISTS ${schema};
  `);
} finally {
  await admin.end();
}

const saver = PostgresSaver.fromConnString(adminUrl, { schema: CHECKPOINT_SCHEMA });
try {
  await saver.setup();
} finally {
  await saver.end();
}

// El Store (fase 8): sus tablas las crea el dueño; la aplicación lo abre con `ensureTables: false`.
const store = new PostgresStore({ connectionOptions: adminUrl, schema: CHECKPOINT_SCHEMA, ensureTables: false });
try {
  await store.setup();
} finally {
  await store.stop();
}

const grants = new pg.Client({ connectionString: adminUrl });
await grants.connect();
try {
  await grants.query(`
    -- Nadie más ve el esquema (anon y authenticated existen en Supabase; PUBLIC siempre).
    REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC;
    DO $$ DECLARE r text; BEGIN
      FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'copilot_reader'] LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE ALL ON SCHEMA ${schema} FROM %I', r);
          EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM %I', r);
        END IF;
      END LOOP;
    END $$;

    -- El rol de la aplicación: datos sí, estructura no.
    REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${ROLE};
    GRANT USAGE ON SCHEMA ${schema} TO ${ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${ROLE};
  `);
} finally {
  await grants.end();
}

try {
  const { status } = await ensureRoleLogin({ adminUrl, roleUrl, expectedRole: ROLE });
  console.log(
    status === "ready"
      ? `Esquema ${CHECKPOINT_SCHEMA} y rol ${ROLE} listos.`
      : `Esquema ${CHECKPOINT_SCHEMA} listo; rol ${ROLE} configurado y listo para conectarse.`,
  );
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
