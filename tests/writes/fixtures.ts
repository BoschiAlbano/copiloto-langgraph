import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { FIXTURES } from "../../evals/action-cases.js";
import { loadEnvFile } from "../../src/config/env.js";

loadEnvFile();

export const ownerUrl = process.env.DATABASE_URL_WRITE;
export const actionsUrl = process.env.DATABASE_URL_ACTIONS;
export const readUrl = process.env.DATABASE_URL_READ;
export const hasWriteDb = Boolean(ownerUrl && actionsUrl && readUrl);

export const TEST_THREAD_PREFIX = "test-";
export const TEST_CLIENT = "TST Cliente Fase5";
export const TEST_SKU = "TST-001";

const DAY_MS = 86_400_000;

/** Un instante lejano y libre (más de un año adelante) para turnos de prueba. */
export const farFuture = (days = 400, minutes = 0) => new Date(Date.now() + days * DAY_MS + minutes * 60_000);

/** Borra todo lo que crean los tests de escritura. Es seguro repetirlo y también limpia restos de una corrida caída. */
export async function cleanupTestData(sql: pg.Client) {
  const fixtureNames = Object.values(FIXTURES);
  await sql.query(
    `DELETE FROM sales
      WHERE id IN (SELECT (payload->'result'->>'saleId')::int FROM action_log
                    WHERE thread_id LIKE $1 AND payload->'result'->>'saleId' IS NOT NULL)
         OR client_id IN (SELECT id FROM clients WHERE name LIKE 'TST %' OR name = ANY($2))`,
    [`${TEST_THREAD_PREFIX}%`, fixtureNames],
  );
  await sql.query(
    `DELETE FROM appointments WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'TST %' OR name = ANY($1))`,
    [fixtureNames],
  );
  await sql.query(`DELETE FROM clients WHERE name LIKE 'TST %' OR name = ANY($1)`, [fixtureNames]);
  await sql.query(`DELETE FROM products WHERE sku LIKE 'TST-%'`);
  await sql.query(`DELETE FROM action_log WHERE thread_id LIKE $1`, [`${TEST_THREAD_PREFIX}%`]);
}

export interface WriteFixtures {
  /** Conexión del dueño, para preparar datos, comprobar resultados y limpiar. */
  sql: pg.Client;
  clientId: number;
  staffId: number;
  serviceId: number;
}

/** Abre la conexión del dueño y crea el cliente y el producto de prueba; al terminar borra todo. */
export function useWriteFixtures() {
  const ctx = {} as WriteFixtures;
  beforeAll(async () => {
    ctx.sql = new pg.Client({ connectionString: ownerUrl });
    await ctx.sql.connect();
    await cleanupTestData(ctx.sql);
    ctx.clientId = (
      await ctx.sql.query(`INSERT INTO clients (name, phone) VALUES ($1, '+54 11 5555-0000') RETURNING id`, [TEST_CLIENT])
    ).rows[0].id;
    await ctx.sql.query(`INSERT INTO products (name, sku, price, stock, min_stock) VALUES ('TST Producto', $1, 1000, 20, 2)`, [
      TEST_SKU,
    ]);
    ctx.staffId = (await ctx.sql.query(`SELECT id FROM staff WHERE name = 'Lucas'`)).rows[0].id;
    ctx.serviceId = (await ctx.sql.query(`SELECT id FROM services WHERE name = 'Corte'`)).rows[0].id;
  });
  afterAll(async () => {
    await cleanupTestData(ctx.sql);
    await ctx.sql.end();
  });
  return ctx;
}
