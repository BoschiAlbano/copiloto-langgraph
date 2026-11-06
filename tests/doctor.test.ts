import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { formatChecks, runChecks, type Query } from "../src/ops/doctor-checks.js";

// Fase 12 (T3, CA2): `doctor` señala cada problema y dice qué hacer. Sin base y sin red: todo es falso.

const migrations = mkdtempSync(join(tmpdir(), "migraciones-"));
for (const m of ["0001_init", "0002_reader_role", "0003_actions_role"]) mkdirSync(join(migrations, m));
afterAll(() => rmSync(migrations, { recursive: true, force: true }));

const ENV = {
  ANTHROPIC_API_KEY: "sk-ant-prueba",
  DATABASE_URL_READ: "postgresql://copilot_reader:x@localhost:54329/postgres",
  DATABASE_URL_CHECKPOINTS: "postgresql://copilot_checkpointer:x@localhost:54329/postgres",
  DATABASE_URL_ACTIONS: "postgresql://copilot_actions:x@localhost:54329/postgres",
  DATABASE_URL_WRITE: "postgresql://postgres:x@localhost:54329/postgres",
};
const pgError = (code: string, message = code) => Object.assign(new Error(message), { code });

/** Una base falsa sana; `broken` cambia lo que contesta cada consulta. */
function db(broken: (url: string, sql: string) => Record<string, unknown>[] | Error | undefined = () => undefined): Query {
  return async (url, sql) => {
    const override = broken(url, sql);
    if (override instanceof Error) throw override;
    if (override) return override;
    if (sql.includes("current_user")) return [{ u: new URL(url).username }];
    if (sql.includes("_prisma_migrations")) return [{ n: 3 }];
    return [{ n: 30 }];
  };
}
const run = (env: Record<string, string | undefined>, query: Query, status = 200) => runChecks(env, { query, models: async () => status, migrationsDir: migrations });
const failed = (results: Awaited<ReturnType<typeof run>>) => results.filter((r) => !r.ok).map((r) => r.name);

describe("doctor", () => {
  it("todo sano: cada comprobación en verde", async () => {
    const results = await run(ENV, db());
    expect(failed(results)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual([
      "Configuración (.env)",
      "Rol copilot_reader",
      "Rol copilot_checkpointer",
      "Rol copilot_actions",
      "Tablas del negocio y datos de prueba",
      "Esquema de hilos (langgraph)",
      "Esquema de trazas (observability)",
      "Migraciones",
      "Clave de la API de Claude",
    ]);
    expect(formatChecks(results)).toContain("✓ Rol copilot_reader: entra con su contraseña");
  });

  it("falta una variable: lo dice, nombra cuál y no sigue", async () => {
    const results = await run({ ...ENV, DATABASE_URL_ACTIONS: undefined }, db());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]!.detail).toMatch(/DATABASE_URL_ACTIONS/);
  });

  it("la base caída: lo dice una vez, sugiere levantarla y no prueba las tablas", async () => {
    const results = await run(ENV, db(() => pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:54329")));
    expect(failed(results)).toEqual(["Rol copilot_reader"]);
    expect(results.find((r) => !r.ok)!.fix).toMatch(/npm run start.*Docker Desktop/);
    expect(results.at(-1)!.name).toBe("Clave de la API de Claude"); // la clave se revisa igual
  });

  it("un rol sin contraseña: sugiere setup", async () => {
    const results = await run(ENV, db((url, sql) => (sql.includes("current_user") && url.includes("copilot_actions") ? pgError("28P01", "password authentication failed") : undefined)));
    expect(failed(results)).toEqual(["Rol copilot_actions"]);
    expect(results.find((r) => !r.ok)!.fix).toMatch(/npm run setup/);
  });

  it("falta un esquema, las tablas están vacías o faltan migraciones: cada uno con su arreglo", async () => {
    const results = await run(
      ENV,
      db((_url, sql) => {
        if (sql.includes("observability")) return pgError("42P01", 'relation "observability.traces" does not exist');
        if (sql.includes("FROM clients")) return [{ n: 0 }];
        if (sql.includes("_prisma_migrations")) return [{ n: 2 }];
        return undefined;
      }),
    );
    expect(failed(results)).toEqual(["Tablas del negocio y datos de prueba", "Esquema de trazas (observability)", "Migraciones"]);
    expect(results.find((r) => r.name === "Esquema de trazas (observability)")).toMatchObject({ detail: "no existe" });
    expect(results.find((r) => r.name === "Esquema de trazas (observability)")!.fix).toMatch(/db:observability/);
    expect(results.find((r) => r.name === "Migraciones")!.detail).toBe("2 de 3 aplicadas");
  });

  it("una clave inválida, y una API que no se alcanza", async () => {
    expect((await run(ENV, db(), 401)).at(-1)).toMatchObject({ ok: false, detail: "la clave no es válida" });
    const offline = await runChecks(ENV, { query: db(), models: async () => { throw new Error("fetch failed"); }, migrationsDir: migrations });
    expect(offline.at(-1)).toMatchObject({ ok: false });
    expect(offline.at(-1)!.fix).toMatch(/internet/);
  });

  it("sin la URL del dueño (no la necesita la aplicación), no revisa las migraciones", async () => {
    const results = await run({ ...ENV, DATABASE_URL_WRITE: undefined }, db());
    expect(results.map((r) => r.name)).not.toContain("Migraciones");
    expect(failed(results)).toEqual([]);
  });
});
