import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvFile } from "../src/config/env.js";

// Requiere haber corrido `npm run db:reset` (crea el rol y los datos).
loadEnvFile();
const url = process.env.DATABASE_URL_READ;

const READ_ONLY = "25006"; // cannot execute ... in a read-only transaction
const NO_PERMISSION = "42501"; // permission denied

describe.skipIf(!url)("rol copilot_reader", () => {
  const client = new pg.Client({ connectionString: url });
  beforeAll(() => client.connect());
  afterAll(() => client.end());

  it("se conecta como copilot_reader y lee las tablas del negocio (la política RLS funciona)", async () => {
    const who = await client.query("SELECT current_user AS u");
    expect(who.rows[0].u).toBe("copilot_reader");
    for (const table of ["clients", "staff", "services", "appointments", "products", "sales", "sale_items"]) {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
      expect(rows[0].n, table).toBeGreaterThan(0);
    }
  });

  describe("la sesión arranca en solo lectura", () => {
    const writes = [
      `INSERT INTO products (name, sku, price, stock, min_stock) VALUES ('x', 'x', 1, 1, 1)`,
      `UPDATE products SET stock = 0`,
      `DELETE FROM sales`,
      `TRUNCATE sale_items`,
      `CREATE TABLE intruso (id int)`,
      `DROP TABLE products`,
    ];
    for (const sql of writes) {
      it(`rechaza: ${sql.slice(0, 40)}`, async () => {
        await expect(client.query(sql)).rejects.toMatchObject({ code: expect.stringMatching(/^(25006|42501)$/) });
      });
    }
  });

  describe("aunque la sesión salga del modo solo lectura, los permisos la frenan", () => {
    // default_transaction_read_only puede cambiarse dentro de la sesión: por eso el
    // GRANT solo-SELECT es la barrera que importa. Cada intento va en su transacción.
    const attempts = [
      `INSERT INTO products (name, sku, price, stock, min_stock) VALUES ('x', 'x', 1, 1, 1)`,
      `UPDATE products SET stock = 0`,
      `DELETE FROM sales`,
      `TRUNCATE sale_items`,
      `CREATE TABLE intruso (id int)`,
      `ALTER TABLE products ADD COLUMN intruso int`,
    ];
    for (const sql of attempts) {
      it(`rechaza: ${sql.slice(0, 40)}`, async () => {
        await client.query("BEGIN");
        try {
          await client.query("SET TRANSACTION READ WRITE");
          await expect(client.query(sql)).rejects.toMatchObject({ code: NO_PERMISSION });
        } finally {
          await client.query("ROLLBACK");
        }
      });
    }
  });

  it("no puede leer action_log", async () => {
    await expect(client.query("SELECT * FROM action_log")).rejects.toMatchObject({ code: NO_PERMISSION });
  });

  it("no puede leer las tablas de autenticación de Supabase", async () => {
    // Con Supabase, el esquema auth existe y el rol no tiene permiso. Con un Postgres solo (fase 12), no existe.
    const hasAuth = (await client.query("SELECT to_regnamespace('auth') IS NOT NULL AS ok")).rows[0].ok;
    await expect(client.query("SELECT * FROM auth.users LIMIT 1")).rejects.toMatchObject({ code: hasAuth ? NO_PERMISSION : "42P01" });
  });

  it("no cambió los datos (los intentos de escritura no dejaron huellas)", async () => {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM products`);
    expect(rows[0].n).toBe(15);
  });
});
