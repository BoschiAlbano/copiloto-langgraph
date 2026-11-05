import pg from "pg";
import { loadEnvFile } from "../config/env.js";
import { OBSERVABILITY_SCHEMA } from "../observability/store.js";

// Prepara dónde se guardan las trazas y las corridas de evaluación (fase 11), con el dueño de la base:
//   1. crea el esquema `observability` y sus tablas;
//   2. le da al rol de los hilos (copilot_checkpointer) solo lectura y escritura de datos, y se lo quita a los demás:
//      una traza tiene el mismo contenido sensible que un hilo (los mensajes y los resultados de las herramientas).
// Es idempotente. Requiere el rol copilot_checkpointer (`npm run db:checkpoints`).
const ROLE = "copilot_checkpointer";
const schema = `"${OBSERVABILITY_SCHEMA}"`;

loadEnvFile();
const adminUrl = process.env.DATABASE_URL_WRITE;
if (!adminUrl) {
  console.error("Falta DATABASE_URL_WRITE. Revisá tu archivo .env (ver .env.example).");
  process.exit(1);
}

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
try {
  const role = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [ROLE]);
  if (role.rowCount === 0) {
    console.error(`No existe el rol ${ROLE}: corré primero \`npm run db:checkpoints\`.`);
    process.exit(1);
  }
  await admin.query(`
    CREATE SCHEMA IF NOT EXISTS ${schema};

    -- Una fila por turno. El árbol de pasos va entero en \`spans\`: se escribe una vez y se lee entero.
    CREATE TABLE IF NOT EXISTS ${schema}.traces (
      id uuid PRIMARY KEY,
      thread_id text NOT NULL,
      kind text NOT NULL,
      input text,
      started_at timestamptz NOT NULL,
      duration_ms integer NOT NULL,
      status text NOT NULL,
      error text,
      route text[] NOT NULL DEFAULT '{}',
      calls integer NOT NULL,
      input_tokens integer NOT NULL,
      output_tokens integer NOT NULL,
      cost_usd numeric,
      retries integer NOT NULL DEFAULT 0,
      eval_run_id uuid,
      eval_case_id text,
      spans jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS traces_started_at ON ${schema}.traces (started_at DESC);
    CREATE INDEX IF NOT EXISTS traces_thread ON ${schema}.traces (thread_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS traces_eval_run ON ${schema}.traces (eval_run_id) WHERE eval_run_id IS NOT NULL;

    -- Las corridas del set de evaluación (R10 a R14) y el resultado de cada caso en cada corrida.
    CREATE TABLE IF NOT EXISTS ${schema}.eval_runs (
      id uuid PRIMARY KEY,
      label text,
      started_at timestamptz NOT NULL,
      duration_ms integer NOT NULL,
      models jsonb NOT NULL,
      prompts text NOT NULL,
      runs integer NOT NULL,
      passed integer NOT NULL,
      total integer NOT NULL,
      input_tokens integer NOT NULL,
      output_tokens integer NOT NULL,
      cost_usd numeric
    );
    CREATE INDEX IF NOT EXISTS eval_runs_started_at ON ${schema}.eval_runs (started_at DESC);
    CREATE TABLE IF NOT EXISTS ${schema}.eval_results (
      run_id uuid NOT NULL REFERENCES ${schema}.eval_runs (id) ON DELETE CASCADE,
      case_id text NOT NULL,
      category text NOT NULL,
      run_no integer NOT NULL,
      passed boolean NOT NULL,
      failures jsonb NOT NULL,
      reply text NOT NULL,
      input_tokens integer NOT NULL,
      output_tokens integer NOT NULL,
      cost_usd numeric,
      duration_ms integer NOT NULL,
      trace_id uuid,
      PRIMARY KEY (run_id, case_id, run_no)
    );

    -- Nadie más ve el esquema (anon y authenticated existen en Supabase; PUBLIC siempre).
    REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC;
    DO $$ DECLARE r text; BEGIN
      FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'copilot_reader', 'copilot_actions'] LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE ALL ON SCHEMA ${schema} FROM %I', r);
          EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM %I', r);
        END IF;
      END LOOP;
    END $$;

    -- El rol de los hilos: datos sí, estructura no.
    REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${ROLE};
    GRANT USAGE ON SCHEMA ${schema} TO ${ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${ROLE};
  `);
  console.log(`Esquema ${OBSERVABILITY_SCHEMA} listo (trazas y evaluaciones), con permisos para ${ROLE}.`);
} finally {
  await admin.end();
}
