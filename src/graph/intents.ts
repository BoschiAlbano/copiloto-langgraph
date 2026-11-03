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

/** Máximo de tareas en que el router puede partir un mensaje (fase 7). */
export const MAX_TASKS = 3;

/**
 * Lo que devuelve el router: el último mensaje partido en tareas (fase 7). `reason` va primero a propósito: el
 * modelo escribe el motivo antes de decidir, lo que ayuda a acertar en los casos dudosos. Cada tarea lleva su
 * intención y su parte del pedido; las reglas de qué se hace y en qué orden las aplica `normalizePlan`.
 */
export const routerOutputSchema = z.object({
  reason: z.string().min(1).max(160).describe("Una frase corta (máximo 15 palabras) con el motivo de la decisión"),
  tasks: z
    .array(
      z.object({
        intent: z.enum(INTENTS).describe("La intención de esta parte del pedido"),
        request: z.string().min(1).max(300).describe("Esta parte del pedido, reescrita para que se entienda sola"),
      }),
    )
    .min(1)
    .max(MAX_TASKS)
    .describe("Las partes del último mensaje, en el orden en que se pidieron. Casi siempre es una sola."),
});
export type RouterOutput = z.infer<typeof routerOutputSchema>;
