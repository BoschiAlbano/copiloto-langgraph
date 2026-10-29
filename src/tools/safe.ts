import { z } from "zod";

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
  console.error(`[error en ${name}] ${detail}`);
  const code = dbCode(error);
  return `problema del sistema${code ? ` (código ${code})` : ""}`;
}

/**
 * Envuelve el cuerpo de una herramienta: devuelve el resultado como JSON y, ante un error
 * inesperado (caída de la base, permisos, bugs), le da al modelo un mensaje genérico en vez
 * del detalle interno. El detalle completo va a la consola de quien opera el sistema.
 */
export function safeTool<Input>(name: string, run: (input: Input) => Promise<unknown>) {
  return async (input: Input) => {
    try {
      return JSON.stringify(await run(input));
    } catch (error) {
      if (error instanceof ToolUserError || error instanceof z.ZodError) throw error;
      const detail = error instanceof Error ? error.message.trim() : String(error);
      console.error(`[error en herramienta ${name}] ${detail}`);
      const code = dbCode(error);
      throw new Error(
        `La herramienta ${name} falló por un problema del sistema${code ? ` (código ${code})` : ""}. ` +
          "No depende de los parámetros: reintentar con otros valores no lo soluciona.",
      );
    }
  };
}
