import { z } from "zod";

/**
 * A dónde va cada pedido:
 * - query: pregunta por un dato del negocio (agente con herramientas de lectura)
 * - action: pide modificar algo (fase 5: con aprobación humana)
 * - report: pide un resumen que junta varias fuentes (fase 6)
 * - chat: saludo, agradecimiento o charla sobre el propio copiloto
 * - unclear: no se entiende qué se pide
 */
export const INTENTS = ["query", "action", "report", "chat", "unclear"] as const;
export type Intent = (typeof INTENTS)[number];

/**
 * Lo que devuelve el router. `reason` va primero a propósito: el modelo escribe
 * el motivo antes de decidir, lo que ayuda a acertar en los casos dudosos.
 */
export const routerOutputSchema = z.object({
  reason: z.string().min(1).max(160).describe("Una frase corta (máximo 15 palabras) con el motivo de la decisión"),
  intent: z.enum(INTENTS).describe("La intención del último mensaje de la persona"),
});
export type RouterOutput = z.infer<typeof routerOutputSchema>;
