import { readdirSync } from "node:fs";
import pg from "pg";
import { parseEnv } from "../config/env.js";

// Las comprobaciones de `npm run doctor` (fase 12, R3), cada una con su arreglo sugerido. Las dependencias (conectarse a
// la base, llamar a la API) se pasan desde afuera: así se prueban sin base y sin red.

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Qué hacer si falló. */
  fix?: string;
}

/** Corre una consulta con una URL y devuelve las filas (o lanza el error de Postgres). */
export type Query = (url: string, sql: string) => Promise<Record<string, unknown>[]>;
/** Pide la lista de modelos de la API de Claude (no gasta tokens). Devuelve el código HTTP. */
export type ModelsProbe = (apiKey: string) => Promise<number>;

export const pgQuery: Query = async (url, sql) => {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    return (await client.query(sql)).rows;
  } finally {
    await client.end().catch(() => undefined);
  }
};

export const anthropicModels: ModelsProbe = async (apiKey) => {
  const response = await fetch("https://api.anthropic.com/v1/models?limit=1", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(10_000),
  });
  return response.status;
};

const ROLES = [
  { variable: "DATABASE_URL_READ", role: "copilot_reader" },
  { variable: "DATABASE_URL_CHECKPOINTS", role: "copilot_checkpointer" },
  { variable: "DATABASE_URL_ACTIONS", role: "copilot_actions" },
] as const;

const code = (error: unknown) => (error as { code?: string }).code;
const isDown = (error: unknown) => ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET"].includes(code(error) ?? "") || /timeout|ECONNREFUSED/i.test(String((error as Error)?.message));

/** Por qué no se pudo entrar a la base con un rol, y qué hacer. */
function explainConnection(role: string, error: unknown): Pick<CheckResult, "detail" | "fix"> {
  if (isDown(error)) {
    return { detail: "la base no responde", fix: "Levantá la base: `npm run start` (base propia) o tu Supabase. Si Docker está cerrado, abrí Docker Desktop." };
  }
  if (code(error) === "28P01" || code(error) === "28000") {
    return { detail: `el rol ${role} no puede entrar con la contraseña de .env`, fix: "Corré `npm run setup` (o `npm run db:roles` y `npm run db:checkpoints`): le asignan al rol la contraseña de su URL." };
  }
  return { detail: `${(error as Error).message}`, fix: "Revisá la URL en .env (ver .env.example)." };
}

/** Las comprobaciones, en orden. Si falla la configuración, no sigue (las demás dependen de ella). */
export async function runChecks(source: Record<string, string | undefined>, deps: { query?: Query; models?: ModelsProbe; migrationsDir?: string } = {}): Promise<CheckResult[]> {
  const query = deps.query ?? pgQuery;
  const models = deps.models ?? anthropicModels;
  const results: CheckResult[] = [];

  // 1. La configuración.
  let env;
  try {
    env = parseEnv(source);
    results.push({ name: "Configuración (.env)", ok: true, detail: "todas las variables están" });
  } catch (error) {
    results.push({ name: "Configuración (.env)", ok: false, detail: (error as Error).message, fix: "Completá .env a partir de .env.example." });
    return results;
  }

  // 2. Cada rol de la aplicación entra con su contraseña (y, de paso, la base responde).
  let reachable = true;
  for (const { variable, role } of ROLES) {
    const name = `Rol ${role}`;
    try {
      const [row] = await query(env[variable], "SELECT current_user AS u");
      const ok = row?.u === role;
      results.push({ name, ok, detail: ok ? "entra con su contraseña" : `entra como ${String(row?.u)}, no como ${role}`, ...(ok ? {} : { fix: `La URL de ${variable} tiene que usar el usuario ${role}.` }) });
    } catch (error) {
      results.push({ name, ok: false, ...explainConnection(role, error) });
      if (isDown(error)) {
        reachable = false;
        break;
      }
    }
  }

  // 3. Las tablas y los esquemas.
  if (reachable) {
    const tables: [string, string, string, string][] = [
      ["Tablas del negocio y datos de prueba", env.DATABASE_URL_READ, "SELECT COUNT(*)::int AS n FROM clients", "Corré `npm run setup` (migraciones y datos de prueba)."],
      ["Esquema de hilos (langgraph)", env.DATABASE_URL_CHECKPOINTS, "SELECT COUNT(*)::int AS n FROM langgraph.checkpoints", "Corré `npm run db:checkpoints` (o `npm run setup`)."],
      ["Esquema de trazas (observability)", env.DATABASE_URL_CHECKPOINTS, "SELECT COUNT(*)::int AS n FROM observability.traces", "Corré `npm run db:observability` (o `npm run setup`)."],
    ];
    for (const [name, url, sql, fix] of tables) {
      try {
        const [row] = await query(url, sql);
        const n = Number(row?.n ?? 0);
        const empty = name.startsWith("Tablas") && n === 0;
        results.push({ name, ok: !empty, detail: empty ? "las tablas están vacías" : name.startsWith("Tablas") ? `${n} clientes` : "existe", ...(empty ? { fix } : {}) });
      } catch (error) {
        results.push({ name, ok: false, detail: code(error) === "42P01" || code(error) === "3F000" ? "no existe" : (error as Error).message, fix });
      }
    }
    // Las migraciones, si hay con qué mirarlas (la URL del dueño es opcional para correr la app).
    const admin = source.DATABASE_URL_WRITE;
    if (admin) {
      const expected = readdirSync(deps.migrationsDir ?? "prisma/migrations", { withFileTypes: true }).filter((e) => e.isDirectory()).length;
      try {
        const [row] = await query(admin, "SELECT COUNT(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL");
        const n = Number(row?.n ?? 0);
        results.push({ name: "Migraciones", ok: n >= expected, detail: `${n} de ${expected} aplicadas`, ...(n >= expected ? {} : { fix: "Corré `npm run db:migrate` (o `npm run setup`)." }) });
      } catch (error) {
        results.push({ name: "Migraciones", ok: false, detail: code(error) === "42P01" ? "la base no tiene migraciones" : (error as Error).message, fix: "Corré `npm run setup`." });
      }
    }
  }

  // 4. La clave de la API (pedir la lista de modelos no gasta tokens).
  try {
    const status = await models(env.ANTHROPIC_API_KEY);
    const ok = status === 200;
    results.push({
      name: "Clave de la API de Claude",
      ok,
      detail: ok ? "válida" : status === 401 ? "la clave no es válida" : `la API respondió ${status}`,
      ...(ok ? {} : { fix: status === 401 ? "Revisá ANTHROPIC_API_KEY en .env (console.anthropic.com → API Keys)." : "Probá de nuevo en un rato; si sigue, mirá status.anthropic.com." }),
    });
  } catch (error) {
    results.push({ name: "Clave de la API de Claude", ok: false, detail: `no se pudo llegar a la API (${(error as Error).message})`, fix: "Revisá la conexión a internet." });
  }
  return results;
}

/** El informe, para la terminal. */
export function formatChecks(results: CheckResult[]): string {
  return results.map((r) => `${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}${r.ok || !r.fix ? "" : `\n    → ${r.fix}`}`).join("\n");
}
