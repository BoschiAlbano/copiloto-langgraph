import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvFile } from "../../src/config/env.js";
import { backup, pruneBackups, restore } from "../../src/ops/backup-core.js";
import { BUNDLED_CONTAINER, hasDocker, isBundledDb } from "../../src/ops/common.js";

// Fase 12 (R11, CA5): el respaldo se prueba. Solo con la base propia (docker-compose.yml): con un Supabase compartido,
// un test nunca restaura nada.
loadEnvFile();
const adminUrl = process.env.DATABASE_URL_WRITE;
const enabled = isBundledDb(adminUrl) && hasDocker();

describe.skipIf(!enabled)("respaldar, borrar y restaurar (base propia)", () => {
  const sql = new pg.Client({ connectionString: adminUrl });
  const dir = mkdtempSync(join(tmpdir(), "respaldos-"));
  const thread = `test-respaldo-${randomUUID().slice(0, 8)}`;
  const traceId = randomUUID();
  let appointmentId = 0;

  beforeAll(async () => {
    await sql.connect();
    // Un hilo, una traza y un turno agendado, para borrarlos y ver que vuelven.
    await sql.query(`INSERT INTO langgraph.checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint) VALUES ($1, '', 'c1', '{}')`, [thread]);
    await sql.query(
      `INSERT INTO observability.traces (id, thread_id, kind, started_at, duration_ms, status, calls, input_tokens, output_tokens, spans) VALUES ($1, $2, 'new', now(), 1, 'ok', 0, 0, 0, '[]')`,
      [traceId, thread],
    );
    const { rows } = await sql.query(
      `INSERT INTO appointments (client_id, staff_id, service_id, starts_at, ends_at, status)
       SELECT (SELECT MIN(id) FROM clients), (SELECT MIN(id) FROM staff), (SELECT MIN(id) FROM services), now() + interval '900 days', now() + interval '900 days 30 minutes', 'scheduled'
       RETURNING id`,
    );
    appointmentId = rows[0].id;
  });
  afterAll(async () => {
    await sql.query(`DELETE FROM langgraph.checkpoints WHERE thread_id = $1`, [thread]).catch(() => undefined);
    await sql.query(`DELETE FROM observability.traces WHERE id = $1`, [traceId]).catch(() => undefined);
    await sql.query(`DELETE FROM appointments WHERE id = $1`, [appointmentId]).catch(() => undefined);
    await sql.end();
    rmSync(dir, { recursive: true, force: true });
  });

  const present = async () => {
    const q = async (text: string, values: unknown[]) => Number((await sql.query(text, values)).rows[0].n);
    return {
      thread: await q(`SELECT COUNT(*) AS n FROM langgraph.checkpoints WHERE thread_id = $1`, [thread]),
      trace: await q(`SELECT COUNT(*) AS n FROM observability.traces WHERE id = $1`, [traceId]),
      appointment: await q(`SELECT COUNT(*) AS n FROM appointments WHERE id = $1`, [appointmentId]),
      clients: await q(`SELECT COUNT(*) AS n FROM clients WHERE $1::int IS NOT NULL`, [1]),
    };
  };

  it("lo borrado vuelve, y lo demás queda igual", async () => {
    const before = await present();
    expect(before).toMatchObject({ thread: 1, trace: 1, appointment: 1 });
    const acl = async () => String((await sql.query(`SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname = 'public'`)).rows[0].acl);
    const aclBefore = await acl();
    const file = await backup(BUNDLED_CONTAINER, { dir });
    expect(statSync(file).size).toBeGreaterThan(10_000);

    await sql.query(`DELETE FROM langgraph.checkpoints WHERE thread_id = $1`, [thread]);
    await sql.query(`DELETE FROM observability.traces WHERE id = $1`, [traceId]);
    await sql.query(`DELETE FROM appointments WHERE id = $1`, [appointmentId]);
    expect(await present()).toMatchObject({ thread: 0, trace: 0, appointment: 0 });

    await restore(BUNDLED_CONTAINER, file);
    expect(await present()).toEqual(before);
    // El esquema public no se toca: si se borrara y recreara, perdería el uso para todos (`=U`), que el respaldo no
    // reconstruye (pasó en una prueba a mano, sin el filtro de restore).
    expect(await acl(), "los permisos del esquema public no cambian").toBe(aclBefore);
    // La restricción de turnos superpuestos (btree_gist, en el esquema extensions) volvió con la tabla.
    const overlap = await sql
      .query(
        `INSERT INTO appointments (client_id, staff_id, service_id, starts_at, ends_at, status)
         SELECT client_id, staff_id, service_id, starts_at, ends_at, 'scheduled' FROM appointments WHERE id = $1`,
        [appointmentId],
      )
      .then(() => "insertó", (e: { code?: string }) => e.code);
    expect(overlap).toBe("23P01");
  }, 120_000);

  it("se quedan los últimos 10 respaldos", () => {
    const keep = mkdtempSync(join(tmpdir(), "respaldos-viejos-"));
    for (let i = 0; i < 12; i++) {
      const f = join(keep, `copiloto-${i}.dump`);
      writeFileSync(f, "x");
      utimesSync(f, new Date(2026, 0, i + 1), new Date(2026, 0, i + 1));
    }
    expect(pruneBackups(keep, 10).sort()).toEqual(["copiloto-0.dump", "copiloto-1.dump"]);
    rmSync(keep, { recursive: true, force: true });
  });
});
