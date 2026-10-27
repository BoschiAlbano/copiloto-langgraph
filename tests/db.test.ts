import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvFile } from "../src/config/env.js";

// Estos tests leen la base real: hay que haber corrido `npm run db:reset`.
// Los que escriben usan una transacción que siempre se revierte.
loadEnvFile();
const url = process.env.DATABASE_URL_WRITE;

describe.skipIf(!url)("base de datos con seed", () => {
  const client = new pg.Client({ connectionString: url });
  beforeAll(() => client.connect());
  afterAll(() => client.end());

  const count = async (table: string) =>
    Number((await client.query(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0].n);

  it("tiene las cantidades fijas del plan", async () => {
    expect(await count("clients")).toBe(30);
    expect(await count("staff")).toBe(3);
    expect(await count("services")).toBe(4);
    expect(await count("products")).toBe(15);
  });

  it("tiene historial de ~90 días en turnos, ventas y renglones", async () => {
    expect(await count("appointments")).toBeGreaterThan(1500);
    expect(await count("sales")).toBeGreaterThan(1000);
    expect(await count("sale_items")).toBeGreaterThanOrEqual(await count("sales"));
    const { rows } = await client.query(
      `SELECT (MAX(starts_at)::date - MIN(starts_at)::date) AS days FROM appointments`,
    );
    expect(Number(rows[0].days)).toBeGreaterThanOrEqual(90);
  });

  it("ningún barbero tiene turnos superpuestos", async () => {
    const { rows } = await client.query(`
      SELECT COUNT(*) AS n FROM appointments a
      JOIN appointments b ON a.staff_id = b.staff_id AND a.id < b.id
      WHERE a.status <> 'cancelled' AND b.status <> 'cancelled'
        AND tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)`);
    expect(Number(rows[0].n)).toBe(0);
  });

  it("cada venta suma lo mismo que sus renglones", async () => {
    const { rows } = await client.query(`
      SELECT COUNT(*) AS n FROM sales s
      WHERE s.total <> (SELECT COALESCE(SUM(qty * unit_price), 0) FROM sale_items WHERE sale_id = s.id)`);
    expect(Number(rows[0].n)).toBe(0);
  });

  it("ningún producto tiene stock negativo", async () => {
    const { rows } = await client.query(`SELECT COUNT(*) AS n FROM products WHERE stock < 0`);
    expect(Number(rows[0].n)).toBe(0);
  });

  describe("restricciones de la base", () => {
    /** Ejecuta `fn` dentro de una transacción que siempre se revierte. */
    async function inRollback<T>(fn: () => Promise<T>) {
      await client.query("BEGIN");
      try {
        return await fn();
      } finally {
        await client.query("ROLLBACK");
      }
    }

    const anyDoneId = async () =>
      Number((await client.query(`SELECT id FROM appointments WHERE status = 'done' ORDER BY id LIMIT 1`)).rows[0].id);

    /** Intenta agendar un turno con el mismo barbero y horario que el turno `id`. */
    const insertCopyOf = (id: number) =>
      client.query(
        `INSERT INTO appointments (client_id, staff_id, service_id, starts_at, ends_at, status)
         SELECT client_id, staff_id, service_id, starts_at, ends_at, 'scheduled'
         FROM appointments WHERE id = $1`,
        [id],
      );

    it("rechaza un turno que se superpone con otro del mismo barbero", async () => {
      const id = await anyDoneId();
      await inRollback(async () => {
        await expect(insertCopyOf(id)).rejects.toMatchObject({ code: "23P01" });
      });
    });

    it("deja reagendar sobre un horario que ocupaba un turno cancelado", async () => {
      const id = await anyDoneId();
      await inRollback(async () => {
        await client.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [id]);
        await expect(insertCopyOf(id)).resolves.toBeDefined();
      });
    });

    it("rechaza un renglón de venta sin producto ni servicio", async () => {
      await inRollback(async () => {
        await expect(
          client.query(
            `INSERT INTO sale_items (sale_id, qty, unit_price) SELECT id, 1, 100 FROM sales LIMIT 1`,
          ),
        ).rejects.toMatchObject({ code: "23514" });
      });
    });

    it("rechaza stock negativo", async () => {
      await inRollback(async () => {
        await expect(client.query(`UPDATE products SET stock = -1 WHERE id = 1`)).rejects.toMatchObject({
          code: "23514",
        });
      });
    });
  });
});
