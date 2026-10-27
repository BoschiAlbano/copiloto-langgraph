import { existsSync } from "node:fs";
import { z } from "zod";

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  MODEL_AGENT: z.string().min(1).default("claude-haiku-5-5"),
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

/** Carga .env (si existe) y devuelve las variables validadas. */
export function loadEnv(): Env {
  if (existsSync(".env")) process.loadEnvFile(".env");
  return parseEnv(process.env);
}
