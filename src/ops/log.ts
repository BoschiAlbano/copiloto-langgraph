import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

// El registro de operación (fase 12, R8): una línea JSON por evento en logs/copiloto-AAAA-MM-DD.log (fecha de
// Argentina). Los avisos y errores salen además por la consola, con el mismo texto de siempre; los eventos de
// información van solo al archivo. Nunca guarda los mensajes de la persona ni los resultados de las herramientas (para
// eso están las trazas): solo ids, duraciones, costos, estados y el detalle técnico de los errores.

export type Level = "info" | "warn" | "error";

export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  /** `text`: lo que sale por la consola (por defecto, el evento). */
  warn(event: string, text?: string, data?: Record<string, unknown>): void;
  error(event: string, text?: string, data?: Record<string, unknown>): void;
  /** Solo al archivo, con cualquier nivel: para lo que ya se avisa por la consola en otro lado. */
  record(level: Level, event: string, data?: Record<string, unknown>): void;
}

const LOG_PREFIX = "copiloto-";
const day = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(now);

/** Tapa las contraseñas de las URL de conexión que aparecen en un texto (`postgresql://rol:secreto@…` → `rol:***@`). */
export const redact = (text: string) => text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s]+@/gi, "$1:***@");

/** Un error como datos para el registro: nombre, código y mensaje (sin contraseñas). */
export function errorData(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: redact(String(error)) };
  const code = (error as { code?: unknown }).code;
  return { name: error.name, ...(code !== undefined && { code: String(code) }), message: redact(error.message) };
}

function sanitize(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = v instanceof Error ? errorData(v) : typeof v === "string" ? redact(v) : v;
  return out;
}

export interface LoggerOptions {
  /** La carpeta de los archivos; sin carpeta, no escribe archivos (por ejemplo, en los tests). */
  dir?: string;
  clock?: () => Date;
  console?: Pick<Console, "warn" | "error">;
}

export function createLogger({ dir, clock = () => new Date(), console: out = console }: LoggerOptions = {}): Logger {
  let ready = false;
  const write = (level: Level, event: string, data: Record<string, unknown> = {}) => {
    if (!dir) return;
    try {
      if (!ready) {
        mkdirSync(dir, { recursive: true });
        ready = true;
      }
      const now = clock();
      appendFileSync(join(dir, `${LOG_PREFIX}${day(now)}.log`), `${JSON.stringify({ ts: now.toISOString(), level, event, ...sanitize(data) })}\n`);
    } catch {
      // Un registro que no se puede escribir (disco lleno, permisos) no rompe nada: la consola sigue.
    }
  };
  return {
    info: (event, data) => write("info", event, data),
    warn: (event, text, data) => {
      out.warn(text ?? event);
      write("warn", event, { ...(text && { text }), ...data });
    },
    error: (event, text, data) => {
      out.error(text ?? event);
      write("error", event, { ...(text && { text }), ...data });
    },
    record: (level, event, data) => write(level, event, data),
  };
}

/** Borra los archivos del registro de más de `days` días. Devuelve cuántos borró. */
export function pruneLogs(dir: string, days: number, now: Date = new Date()): number {
  let removed = 0;
  try {
    const limit = now.getTime() - days * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(LOG_PREFIX) || !name.endsWith(".log")) continue;
      const date = Date.parse(`${name.slice(LOG_PREFIX.length, -4)}T23:59:59-03:00`);
      const old = Number.isFinite(date) ? date < limit : statSync(join(dir, name)).mtimeMs < limit;
      if (old) {
        rmSync(join(dir, name));
        removed++;
      }
    }
  } catch {
    // Sin carpeta todavía: nada que borrar.
  }
  return removed;
}

/** La carpeta del registro: `logs/` en la raíz del repositorio (también desde la web, que corre en web/). */
export function logDir(): string | undefined {
  if (process.env.COPILOT_LOG_DIR) return process.env.COPILOT_LOG_DIR;
  if (process.env.VITEST) return undefined; // los tests no dejan archivos (salvo que pidan una carpeta)
  return process.cwd().replace(/[\\/]web$/, "") + "/logs";
}

/** El registro del proceso. */
export const log: Logger = createLogger({ dir: logDir() });
