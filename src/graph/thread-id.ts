import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Un hilo es una conversación. El id viaja como valor parametrizado, pero igual se limita a un
 * alfabeto corto: es lo que la persona escribe en la terminal y aparece en los listados.
 */
export const threadIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "El id del hilo admite de 1 a 64 caracteres: letras, números, guion y guion bajo.");

/** Valida un id escrito por una persona; el mensaje del error se puede mostrar tal cual. */
export function parseThreadId(value: string): string {
  const result = threadIdSchema.safeParse(value);
  if (!result.success) throw new Error(result.error.issues[0]!.message);
  return result.data;
}

/** Id nuevo, corto para poder copiarlo: `hilo-` más 8 caracteres hexadecimales. */
export function newThreadId(): string {
  return `hilo-${randomBytes(4).toString("hex")}`;
}
