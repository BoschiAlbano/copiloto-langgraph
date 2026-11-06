import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { BUNDLED_CONTAINER, isBundledDb } from "./common.js";

// Respaldo y restauración de la base del copiloto (fase 12, R9 a R11), con pg_dump y pg_restore corridos adentro del
// contenedor de la base. Solo los esquemas del copiloto: con un Supabase compartido, nunca se respalda ni se pisa lo
// de otras aplicaciones.

/** Los esquemas del copiloto: las tablas del negocio, los hilos y memorias, y las trazas y evaluaciones. */
export const SCHEMAS = ["public", "langgraph", "observability"] as const;
export const BACKUP_DIR = "backups";
export const KEEP_BACKUPS = 10;

/** El contenedor de la base: el propio, o el de BACKUP_CONTAINER (por ejemplo, `supabase-db`). */
export function backupContainer(env: Record<string, string | undefined> = process.env): string {
  if (isBundledDb(env.DATABASE_URL_WRITE)) return BUNDLED_CONTAINER;
  if (env.BACKUP_CONTAINER) return env.BACKUP_CONTAINER;
  throw new Error("La base de .env no es la propia: definí BACKUP_CONTAINER con el nombre de su contenedor (por ejemplo, supabase-db).");
}

const stamp = (now: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
};

/** Hace un respaldo (`pg_dump -Fc` de los esquemas del copiloto) y devuelve la ruta del archivo. */
export async function backup(container: string, { dir = BACKUP_DIR, label = "", now = new Date() } = {}): Promise<string> {
  mkdirSync(dir, { recursive: true });
  // El nombre dice de qué base es (copiloto-db, supabase-db…) y, si lo tiene, para qué se hizo (antes-de-restaurar).
  const file = join(dir, `${container}${label ? `-${label}` : ""}-${stamp(now)}.dump`);
  const child = spawn("docker", ["exec", container, "pg_dump", "-U", "postgres", "-d", "postgres", "-Fc", ...SCHEMAS.flatMap((s) => ["-n", s])], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  await pipeline(child.stdout, createWriteStream(file));
  const code = await exited;
  if (code !== 0 || statSync(file).size === 0) {
    rmSync(file, { force: true });
    throw new Error(`pg_dump falló (código ${code}): ${stderr.trim() || "sin detalle"}`);
  }
  return file;
}

/** Deja solo los últimos `keep` respaldos de la carpeta. Devuelve los que borró. */
export function pruneBackups(dir = BACKUP_DIR, keep = KEEP_BACKUPS): string[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".dump"));
  } catch {
    return [];
  }
  const old = files
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(keep)
    .map(({ f }) => f);
  for (const f of old) rmSync(join(dir, f));
  return old;
}

function docker(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/**
 * Restaura un respaldo: reemplaza lo que hay en los esquemas del copiloto (`pg_restore --clean`), en una sola
 * transacción (si algo falla, no cambia nada). Saltea las entradas del esquema `public` en sí (crearlo, borrarlo, su
 * comentario y sus permisos): restaura sus tablas, pero nunca toca el esquema, que en un Supabase es compartido.
 */
export async function restore(container: string, file: string): Promise<void> {
  const inside = `/tmp/${basename(file)}`;
  await pipeline(createReadStream(file), spawnStdin(container, inside));
  try {
    const script = [
      `pg_restore -l ${inside} | grep -v -E 'SCHEMA - public |COMMENT - SCHEMA public|ACL - SCHEMA public' > ${inside}.list`,
      `pg_restore -U postgres -d postgres --clean --if-exists --single-transaction -L ${inside}.list ${inside}`,
    ].join(" && ");
    const r = docker(["exec", container, "sh", "-c", script]);
    if (!r.ok) throw new Error(`pg_restore falló: ${r.out || "sin detalle"}`);
  } finally {
    docker(["exec", container, "rm", "-f", inside, `${inside}.list`]);
  }
}

/** Un archivo adentro del contenedor, para escribirlo desde afuera. */
function spawnStdin(container: string, path: string) {
  const child = spawn("docker", ["exec", "-i", container, "sh", "-c", `cat > ${path}`], { stdio: ["pipe", "ignore", "inherit"] });
  return child.stdin;
}

/** Cuánto hay en cada esquema, para decir qué se va a reemplazar. */
export function inventory(container: string): string {
  const sql =
    "SELECT n.nspname || ': ' || COUNT(c.oid) || ' tablas' FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind = 'r' " +
    `WHERE n.nspname IN (${SCHEMAS.map((s) => `'${s}'`).join(", ")}) GROUP BY n.nspname ORDER BY n.nspname`;
  const counts =
    "SELECT 'clientes: ' || (SELECT COUNT(*) FROM public.clients) || ' · turnos: ' || (SELECT COUNT(*) FROM public.appointments) || " +
    "' · hilos: ' || (SELECT COUNT(DISTINCT thread_id) FROM langgraph.checkpoints) || ' · trazas: ' || (SELECT COUNT(*) FROM observability.traces)";
  const a = docker(["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql]);
  const b = docker(["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-tAc", counts]);
  return [a.out, b.ok ? b.out : ""].filter(Boolean).join("\n");
}
