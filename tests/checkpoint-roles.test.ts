import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvFile } from "../src/config/env.js";

// Requiere haber corrido `npm run db:reset` o `npm run db:checkpoints`.
loadEnvFile();
const checkpointsUrl = process.env.DATABASE_URL_CHECKPOINTS;
const readUrl = process.env.DATABASE_URL_READ;
const adminUrl = process.env.DATABASE_URL_WRITE;

const NO_PERMISSION = "42501";
// Desde la fase 8 el esquema también tiene las tablas del Store (memoria de largo plazo), con los mismos permisos.
const TABLES = ["checkpoints", "checkpoint_blobs", "checkpoint_writes", "checkpoint_migrations", "store", "store_migrations"];

describe.skipIf(!checkpointsUrl)("rol copilot_checkpointer", () => {
  const client = new pg.Client({ connectionString: checkpointsUrl });
  beforeAll(() => client.connect());
  afterAll(() => client.end());

  it("entra como copilot_checkpointer y puede leer las tablas de LangGraph", async () => {
    const who = await client.query("SELECT current_user AS u");
    expect(who.rows[0].u).toBe("copilot_checkpointer");
    for (const table of TABLES) {
      await expect(client.query(`SELECT COUNT(*) FROM langgraph.${table}`), table).resolves.toBeDefined();
    }
  });

  it("puede escribir y borrar datos en sus tablas", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO langgraph.checkpoints (thread_id, checkpoint_id, checkpoint) VALUES ('test-roles', 'c1', '{}')`,
      );
      await client.query(`UPDATE langgraph.checkpoints SET metadata = '{"a":1}' WHERE thread_id = 'test-roles'`);
      const del = await client.query(`DELETE FROM langgraph.checkpoints WHERE thread_id = 'test-roles'`);
      expect(del.rowCount).toBe(1);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  describe("no puede tocar la estructura", () => {
    const attempts = [
      `CREATE TABLE langgraph.intruso (id int)`,
      `CREATE TABLE public.intruso (id int)`,
      `ALTER TABLE langgraph.checkpoints ADD COLUMN intruso int`,
      `DROP TABLE langgraph.checkpoints`,
      `TRUNCATE langgraph.checkpoints`,
    ];
    for (const sql of attempts) {
      it(`rechaza: ${sql}`, async () => {
        await client.query("BEGIN");
        try {
          await expect(client.query(sql)).rejects.toMatchObject({ code: expect.stringMatching(/^42501$/) });
        } finally {
          await client.query("ROLLBACK");
        }
      });
    }
  });

  describe("no ve los datos del negocio", () => {
    for (const table of ["clients", "appointments", "sales", "products", "action_log"]) {
      it(`rechaza leer ${table}`, async () => {
        await expect(client.query(`SELECT * FROM public."${table}" LIMIT 1`)).rejects.toMatchObject({
          code: NO_PERMISSION,
        });
      });
    }
    it("rechaza leer las tablas de autenticación de Supabase", async () => {
      await expect(client.query("SELECT * FROM auth.users LIMIT 1")).rejects.toMatchObject({ code: NO_PERMISSION });
    });
  });
});

describe.skipIf(!readUrl)("el rol de lectura no ve los hilos", () => {
  const client = new pg.Client({ connectionString: readUrl });
  beforeAll(() => client.connect());
  afterAll(() => client.end());

  for (const table of TABLES) {
    it(`copilot_reader rechaza leer langgraph.${table}`, async () => {
      await expect(client.query(`SELECT * FROM langgraph.${table} LIMIT 1`)).rejects.toMatchObject({
        code: NO_PERMISSION,
      });
    });
  }
});

describe.skipIf(!adminUrl)("ningún otro rol tiene permisos sobre el esquema langgraph", () => {
  const client = new pg.Client({ connectionString: adminUrl });
  beforeAll(() => client.connect());
  afterAll(() => client.end());

  it("anon, authenticated y copilot_reader no tienen USAGE ni permisos de tabla", async () => {
    for (const role of ["anon", "authenticated", "copilot_reader"]) {
      const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (exists.rowCount === 0) continue;
      const usage = await client.query("SELECT has_schema_privilege($1, 'langgraph', 'USAGE') AS ok", [role]);
      expect(usage.rows[0].ok, `${role} USAGE`).toBe(false);
      for (const table of TABLES) {
        const { rows } = await client.query(
          `SELECT has_table_privilege($1, 'langgraph.${table}', 'SELECT, INSERT, UPDATE, DELETE') AS ok`,
          [role],
        );
        expect(rows[0].ok, `${role} ${table}`).toBe(false);
      }
    }
  });

  it("el rol de la API REST de Supabase (authenticator) tampoco entra al esquema", async () => {
    // PostgREST publica solo los esquemas de su configuración; además, sin permisos no podría leerlos.
    const { rows } = await client.query(`SELECT has_schema_privilege('authenticator', 'langgraph', 'USAGE') AS ok`).catch(
      () => ({ rows: [{ ok: false }] }),
    );
    expect(rows[0].ok).toBe(false);
  });
});
