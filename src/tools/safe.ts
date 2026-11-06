import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import { announceRetry } from "./retry-events.js";
import { DEFAULT_ATTEMPTS, isTransient, withRetry, type RetryOptions } from "./retry.js";
import { log } from "../ops/log.js";

/** Error pensado para que el modelo lo lea y corrija sus parámetros (por ejemplo, un barbero inexistente). */
export class ToolUserError extends Error {}

/** Código de Postgres si el error viene de la base (Prisma lo deja en `meta.code`). */
function dbCode(error: unknown): string | undefined {
  const e = error as { code?: string; meta?: { code?: string } };
  return e.meta?.code ?? e.code;
}

/**
 * Un error como texto para MOSTRAR a una persona (por ejemplo, en un reporte): los errores esperables (límites, datos
 * inválidos) se informan tal cual; cualquier otro (la base caída, permisos, un bug) se informa con un texto genérico y
 * su código, y el detalle va a la consola de quien opera el sistema.
 */
export function explainError(name: string, error: unknown): string {
  if (error instanceof ToolUserError) return error.message;
  if (error instanceof z.ZodError) return error.issues.map((i) => i.message).join("; ");
  const detail = error instanceof Error ? error.message.trim() : String(error);
  log.error("error-del-sistema", `[error en ${name}] ${detail}`, { where: name, error });
  const code = dbCode(error);
  return `problema del sistema${code ? ` (código ${code})` : ""}`;
}

/**
 * Envuelve el cuerpo de una herramienta: devuelve el resultado como JSON y, ante un error
 * inesperado (caída de la base, permisos, bugs), le da al modelo un mensaje genérico en vez
 * del detalle interno. El detalle completo va a la consola de quien opera el sistema.
 */
export function safeTool<Input>(name: string, run: (input: Input) => Promise<unknown>, retry: RetryOptions = {}) {
  return async (input: Input, config?: LangGraphRunnableConfig) => {
    try {
      // Fase 10: una falla transitoria de la base (conexión caída, servidor que se reinicia) se reintenta acá adentro.
      // El nodo de herramientas nunca ve el error (se convierte en mensaje), así que una retryPolicy del nodo no serviría.
      const result = await withRetry(() => run(input), {
        ...retry,
        onRetry: (info) => {
          log.warn("reintento", `[reintento] ${name} ${info.attempt} de ${info.attempts} (en ${info.delayMs} ms)`, { target: name, attempt: info.attempt, attempts: info.attempts });
          announceRetry({ target: name, attempt: info.attempt, attempts: info.attempts }, config);
          retry.onRetry?.(info);
        },
      });
      return JSON.stringify(result);
    } catch (error) {
      if (error instanceof ToolUserError || error instanceof z.ZodError) throw error;
      const detail = error instanceof Error ? error.message.trim() : String(error);
      log.error("herramienta-fallo", `[error en herramienta ${name}] ${detail}`, { tool: name, error });
      const code = dbCode(error);
      throw new Error(
        `La herramienta ${name} falló por un problema del sistema${code ? ` (código ${code})` : ""}. ` +
          (isTransient(error) ? `Ya se reintentó ${retry.attempts ?? DEFAULT_ATTEMPTS} veces sin éxito: la base no responde. ` : "") +
          "No depende de los parámetros: reintentar con otros valores no lo soluciona. Decile a la persona que no pudiste consultar ese dato y no lo inventes.",
      );
    }
  };
}
