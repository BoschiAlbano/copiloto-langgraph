import { z } from "zod";
import { ACTION_NAMES, type ActionName } from "../tools/actions/schemas.js";

// Lo que viaja por el estado del grafo y por `interrupt` en el flujo de aprobación.

const params = z.record(z.string(), z.unknown());

/** La acción propuesta, tal como se le muestra a la persona. El resumen lo arma el código, no el modelo. */
export const pendingActionSchema = z.object({
  /** `thread_id:id-de-la-llamada`: único por acción propuesta; es la clave de "se ejecuta una sola vez". */
  id: z.string().min(1),
  /** Id de la llamada a herramienta del modelo a la que hay que responder con un mensaje de herramienta. */
  toolCallId: z.string().min(1),
  tool: z.enum(ACTION_NAMES as [ActionName, ...ActionName[]]),
  /** Lo que se ejecuta si la persona aprueba. Si se editó, son los parámetros editados. */
  params,
  /** Los parámetros que propuso el modelo, solo si la persona los editó (queda para la auditoría). */
  originalParams: params.optional(),
  risk: z.enum(["low", "medium", "high"]),
  summary: z.string().min(1),
});
export type PendingAction = z.infer<typeof pendingActionSchema>;

/** Decisión ya procesada, guardada en el estado. */
export const approvalSchema = z.object({
  actionId: z.string().min(1),
  /**
   * `approved` y `rejected` cierran la propuesta (`execute_action` las usa).
   * `revised`: la persona editó la propuesta; NO se ejecuta, se vuelve a preguntar con la tarjeta nueva.
   * `invalid`: la respuesta no se pudo usar (formato o edición inválida); se vuelve a preguntar.
   */
  decision: z.enum(["approved", "rejected", "revised", "invalid"]),
  comment: z.string().optional(),
  error: z.string().optional(),
});
export type Approval = z.infer<typeof approvalSchema>;

/**
 * Lo que responde la persona al `interrupt` (es el valor de `Command({ resume })`). Estricto: un campo de más
 * o un tipo equivocado no se interpreta, se vuelve a preguntar.
 */
export const humanDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("approve") }),
  z.strictObject({ decision: z.literal("reject"), comment: z.string().trim().max(200).optional() }),
  z.strictObject({ decision: z.literal("edit"), params }),
]);
export type HumanDecision = z.infer<typeof humanDecisionSchema>;

/** Lo que `interrupt` le entrega a quien invoca el grafo: sirve para mostrar la tarjeta. */
export interface ApprovalRequest {
  kind: "approve_action";
  action: PendingAction;
  /** Por qué se vuelve a preguntar (decisión inválida o edición rechazada). La propuesta anterior sigue pendiente. */
  error?: string;
  /** La persona acaba de editar la propuesta: la tarjeta ya muestra lo editado y todavía no se ejecutó nada. */
  edited?: true;
}
