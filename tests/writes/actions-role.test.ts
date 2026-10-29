import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionsUrl, farFuture, hasWriteDb, readUrl, TEST_SKU, TEST_THREAD_PREFIX, useWriteFixtures } from "./fixtures.js";

const NO_PERMISSION = "42501";
const UNIQUE_VIOLATION = "23505";

// CA8: el rol copilot_actions puede escribir lo justo y nada más. Requiere `npm run db:reset`.
describe.skipIf(!hasWriteDb)("rol copilot_actions", () => {
  const fx = useWriteFixtures();
  const actions = new pg.Client({ connectionString: actionsUrl });
  beforeAll(() => actions.connect());
  afterAll(() => actions.end());

  it("entra como copilot_actions, con la sesión en lectura y escritura y con tope de tiempo", async () => {
    expect((await actions.query("SELECT current_user AS u")).rows[0].u).toBe("copilot_actions");
    expect((await actions.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only).toBe("off");
    expect((await actions.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("5s");
  });

  describe("lo que sí puede hacer", () => {
    it("agendar y cancelar un turno (solo cambia `status`)", async () => {
      const startsAt = farFuture(400);
      const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
      const { rows } = await actions.query(
        `INSERT INTO appointments (client_id, staff_id, service_id, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, status`,
        [fx.clientId, fx.staffId, fx.serviceId, startsAt, endsAt],
      );
      expect(rows[0].status).toBe("scheduled");
      const upd = await actions.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [rows[0].id]);
      expect(upd.rowCount).toBe(1);
    });

    it("ajustar stock", async () => {
      const upd = await actions.query(`UPDATE products SET stock = stock + 5 WHERE sku = $1 RETURNING stock`, [TEST_SKU]);
      expect(upd.rows[0].stock).toBe(25);
    });

    it("registrar una venta con sus renglones", async () => {
      const sale = await actions.query(
        `INSERT INTO sales (client_id, total, payment_method) VALUES ($1, 2000, 'cash') RETURNING id`,
        [fx.clientId],
      );
      const productId = (await actions.query(`SELECT id FROM products WHERE sku = $1`, [TEST_SKU])).rows[0].id;
      await actions.query(`INSERT INTO sale_items (sale_id, product_id, qty, unit_price) VALUES ($1, $2, 2, 1000)`, [
        sale.rows[0].id,
        productId,
      ]);
    });

    it("escribir en la auditoría, y no repetir el mismo id de acción", async () => {
      const insert = (actionId: string) =>
        actions.query(
          `INSERT INTO action_log (thread_id, action, payload, decision, decided_at)
           VALUES ($1, 'adjustStock', $2::jsonb, 'approved', now())`,
          [`${TEST_THREAD_PREFIX}role`, JSON.stringify({ actionId })],
        );
      await insert("test-role:call-1");
      await expect(insert("test-role:call-1")).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
      await insert("test-role:call-2"); // otro id sí
    });
  });

  describe("lo que no puede hacer", () => {
    const denied = [
      // Borrar: nada.
      `DELETE FROM appointments WHERE id = -1`,
      `DELETE FROM sales WHERE id = -1`,
      `DELETE FROM clients WHERE id = -1`,
      `DELETE FROM action_log WHERE id = -1`,
      `TRUNCATE appointments CASCADE`,
      `TRUNCATE action_log`,
      // Cambiar otras columnas.
      `UPDATE clients SET name = 'x' WHERE id = -1`,
      `UPDATE products SET price = 1 WHERE id = -1`,
      `UPDATE products SET name = 'x' WHERE id = -1`,
      `UPDATE appointments SET starts_at = now() WHERE id = -1`,
      `UPDATE sales SET total = 0 WHERE id = -1`,
      // La auditoría no se modifica.
      `UPDATE action_log SET decision = 'rejected' WHERE id = -1`,
      // Crear filas donde no le corresponde.
      `INSERT INTO clients (name) VALUES ('intruso')`,
      `INSERT INTO products (name, sku, price, stock, min_stock) VALUES ('x', 'x', 1, 1, 1)`,
      `INSERT INTO staff (name) VALUES ('intruso')`,
      // Estructura.
      `CREATE TABLE intruso (id int)`,
      `ALTER TABLE products ADD COLUMN intruso int`,
      `DROP TABLE products`,
      // Otros esquemas.
      `SELECT * FROM langgraph.checkpoints LIMIT 1`,
      `SELECT * FROM auth.users LIMIT 1`,
    ];
    for (const sql of denied) {
      it(`rechaza: ${sql}`, async () => {
        await expect(actions.query(sql)).rejects.toMatchObject({ code: NO_PERMISSION });
      });
    }
  });

  describe("los otros roles de la aplicación siguen sin poder escribir en el negocio", () => {
    it("copilot_reader no puede escribir ni leer la auditoría", async () => {
      const reader = new pg.Client({ connectionString: readUrl });
      await reader.connect();
      try {
        await expect(reader.query(`INSERT INTO action_log (thread_id, action, payload) VALUES ('x','x','{}')`)).rejects.toMatchObject({
          code: expect.stringMatching(/^(25006|42501)$/),
        });
        await expect(reader.query(`SELECT * FROM action_log LIMIT 1`)).rejects.toMatchObject({ code: NO_PERMISSION });
      } finally {
        await reader.end();
      }
    });

    it("copilot_checkpointer no puede escribir en el negocio", async () => {
      const cp = new pg.Client({ connectionString: process.env.DATABASE_URL_CHECKPOINTS });
      await cp.connect();
      try {
        await expect(cp.query(`UPDATE products SET stock = 0 WHERE id = -1`)).rejects.toMatchObject({ code: NO_PERMISSION });
        await expect(cp.query(`INSERT INTO action_log (thread_id, action, payload) VALUES ('x','x','{}')`)).rejects.toMatchObject({
          code: NO_PERMISSION,
        });
      } finally {
        await cp.end();
      }
    });
  });
});
