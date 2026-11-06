import { existsSync } from "node:fs";
import { z } from "zod";

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  MODEL_AGENT: z.string().min(1).default("claude-haiku-5-5"),
  // El router corre en cada turno: conviene un modelo barato.
  MODEL_ROUTER: z.string().min(1).default("claude-haiku-5-5"),
  // Escribe la «Lectura» de los reportes (fase 6). Las cifras no pasan por este modelo: las arma el código.
  MODEL_REPORT: z.string().min(1).default("claude-haiku-5-5"),
  // Rol de solo lectura (copilot_reader): lo usan las herramientas del agente.
  DATABASE_URL_READ: z.string().min(1),
  // Rol copilot_checkpointer: guarda y lee los hilos de conversación, nada más.
  DATABASE_URL_CHECKPOINTS: z.string().min(1),
  // Rol copilot_actions: el único que escribe datos del negocio, y solo después de una aprobación.
  DATABASE_URL_ACTIONS: z.string().min(1),
  // Cuántos días se conservan las trazas de los turnos (fase 11). Las más viejas se borran al arrancar.
  TRACE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  // Fase 12: límites de operación (todos opcionales).
  // Tope de gasto por día en la API de Claude, en dólares; 0 lo desactiva.
  DAILY_BUDGET_USD: z.coerce.number().min(0).default(1),
  // Límite de una llamada al modelo (sumado a sus reintentos) y de un turno entero, en milisegundos.
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  // Cuántos días se guardan los registros de operación (logs/).
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
});

export type Env = z.infer<typeof envSchema>;

/** Valida las variables de entorno; si falta alguna, el error nombra cuáles. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `Faltan variables de entorno o son inválidas: ${missing}. Revisá tu archivo .env (ver .env.example).`,
    );
  }
  return result.data;
}

/** Carga .env en process.env si el archivo existe. */
export function loadEnvFile() {
  if (existsSync(".env")) process.loadEnvFile(".env");
}

/** Carga .env (si existe) y devuelve las variables validadas. */
export function loadEnv(): Env {
  loadEnvFile();
  return parseEnv(process.env);
}

/**
 * Lo mismo, para un comando de la terminal (fase 12, R4): si falta una variable, dice cuál y sale, sin la pila del error.
 */
export function loadEnvOrExit(): Env {
  try {
    return loadEnv();
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exit(1);
  }
}
