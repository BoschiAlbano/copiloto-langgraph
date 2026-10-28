import { describe, expect, it } from "vitest";
import { listAppointments, listAppointmentsInput } from "../../src/tools/list-appointments.js";
import { hasDb, useDatabases } from "./helpers.js";

const AR = `'America/Argentina/Buenos_Aires'`;

describe.skipIf(!hasDb)("listAppointments", () => {
  const ctx = useDatabases();

  /** Día local (YYYY-MM-DD) a `offset` días de hoy, según la propia base y no el código de la herramienta. */
  const rel = async (offset: number) =>
    (await ctx.sql.query(`SELECT ((now() AT TIME ZONE ${AR})::date + $1::int)::text AS d`, [offset])).rows[0].d as string;
  const tomorrow = () => rel(1);

  it("el total de mañana coincide con una consulta SQL independiente", async () => {
    const day = await tomorrow();
    const r = await listAppointments(ctx.db, { dateFrom: day, dateTo: day });
    const { rows } = await ctx.sql.query(
      `SELECT status, COUNT(*)::int AS n FROM appointments
       WHERE (starts_at AT TIME ZONE ${AR})::date = $1::date GROUP BY status`,
      [day],
    );
    const expected = Object.fromEntries(rows.map((x) => [x.status, x.n]));
    expect(r.countByStatus).toEqual(expected);
    expect(r.total).toBe(rows.reduce((s, x) => s + x.n, 0));
    expect(r.total).toBeGreaterThan(0);
  });

  it("devuelve los turnos ordenados, con hora de Argentina y solo del día pedido", async () => {
    const day = await tomorrow();
    const r = await listAppointments(ctx.db, { dateFrom: day, dateTo: day });
    const starts = r.appointments.map((a) => a.startsAt);
    expect(starts).toEqual([...starts].sort());
    for (const s of starts) {
      expect(s.startsWith(day)).toBe(true);
      expect(s.endsWith("-03:00")).toBe(true);
    }
    expect(r.appointments[0]).toMatchObject({
      client: { id: expect.any(Number), name: expect.any(String) },
      staff: expect.any(String),
      service: expect.any(String),
    });
  });

  it("recorta a 50, informa el total real y marca truncated", async () => {
    const [dateFrom, dateTo] = [await rel(-30), await rel(-1)];
    const r = await listAppointments(ctx.db, { dateFrom, dateTo });
    const { rows } = await ctx.sql.query(
      `SELECT COUNT(*)::int AS n FROM appointments
       WHERE (starts_at AT TIME ZONE ${AR})::date BETWEEN $1::date AND $2::date`,
      [dateFrom, dateTo],
    );
    expect(r.appointments).toHaveLength(50);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(rows[0].n);
  });

  it("filtra por barbero sin importar acentos", async () => {
    const r = await listAppointments(ctx.db, { dateFrom: await rel(-7), dateTo: await rel(-1), staffName: "NICOLAS" });
    expect(r.total).toBeGreaterThan(0);
    expect(new Set(r.appointments.map((a) => a.staff))).toEqual(new Set(["Nicolás"]));
  });

  it("filtra por estado y por cliente", async () => {
    const byStatus = await listAppointments(ctx.db, { dateFrom: await rel(-14), dateTo: await rel(-1), status: "cancelled" });
    expect(byStatus.appointments.every((a) => a.status === "cancelled")).toBe(true);

    const [dateFrom, dateTo] = [await rel(-30), await rel(-1)];
    const { rows } = await ctx.sql.query(
      `SELECT client_id, COUNT(*)::int AS n FROM appointments
       WHERE (starts_at AT TIME ZONE ${AR})::date BETWEEN $1::date AND $2::date
       GROUP BY client_id ORDER BY n DESC, client_id LIMIT 1`,
      [dateFrom, dateTo],
    );
    const r = await listAppointments(ctx.db, { dateFrom, dateTo, clientId: rows[0].client_id });
    expect(r.total).toBe(rows[0].n);
  });

  it("incluye el último día completo (hasta las 23:59 locales)", async () => {
    // Un turno a las 19:xx locales es ya el día siguiente en UTC-0: no debe perderse ni duplicarse.
    const { rows } = await ctx.sql.query(
      `SELECT (starts_at AT TIME ZONE ${AR})::date::text AS d FROM appointments
       WHERE (starts_at AT TIME ZONE ${AR})::time >= '19:00' LIMIT 1`,
    );
    const day = rows[0].d as string;
    const r = await listAppointments(ctx.db, { dateFrom: day, dateTo: day });
    expect(r.appointments.some((a) => a.startsAt.slice(11, 13) >= "19")).toBe(true);
    expect(r.appointments.every((a) => a.startsAt.startsWith(day))).toBe(true);
  });

  it("un barbero inexistente da un error que lista los barberos reales", async () => {
    await expect(
      listAppointments(ctx.db, { dateFrom: await rel(-1), dateTo: await rel(-1), staffName: "Roberto" }),
    ).rejects.toThrow(/Martín, Lucas, Nicolás/);
  });
});

describe("listAppointmentsInput", () => {
  const ok = { dateFrom: "2026-10-01", dateTo: "2026-10-31" };

  it("acepta un rango de hasta 31 días", () => {
    expect(listAppointmentsInput.safeParse(ok).success).toBe(true);
  });

  it("rechaza rangos de más de 31 días, invertidos o con fechas inexistentes", () => {
    expect(listAppointmentsInput.safeParse({ dateFrom: "2026-10-01", dateTo: "2026-11-02" }).success).toBe(false);
    expect(listAppointmentsInput.safeParse({ dateFrom: "2026-10-05", dateTo: "2026-10-01" }).success).toBe(false);
    expect(listAppointmentsInput.safeParse({ dateFrom: "2026-02-30", dateTo: "2026-03-01" }).success).toBe(false);
    expect(listAppointmentsInput.safeParse({ dateFrom: "mañana", dateTo: "mañana" }).success).toBe(false);
  });

  it("rechaza estados y parámetros desconocidos", () => {
    expect(listAppointmentsInput.safeParse({ ...ok, status: "borrado" }).success).toBe(false);
    expect(listAppointmentsInput.safeParse({ ...ok, where: "1=1" }).success).toBe(false);
  });
});
