import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { z } from "zod";

// Salidas estructuradas mal formadas (fase 10, R8). El router, la memoria y el planificador de reportes piden al modelo
// una salida con esquema. Si no lo cumple, en vez de ir directo al respaldo, se le da UN segundo intento con la
// corrección: qué contestó y por qué no sirve. Si tampoco sirve, quien llama usa su respaldo de siempre y lo informa.

/** Lo que devuelve un modelo con `withStructuredOutput(…, { includeRaw: true })`. */
export interface StructuredModel {
  invoke(messages: BaseMessage[]): Promise<{ parsed?: unknown; raw?: unknown; parsingError?: unknown } | null | undefined>;
}

/** Valida lo que contestó el modelo: el valor listo para usar, o el motivo en palabras que el modelo entienda. */
export type Check<T> = (parsed: unknown) => { ok: true; value: T } | { ok: false; error: string };

/** Un `Check` a partir de un esquema de Zod. */
export function zodCheck<S extends z.ZodType>(schema: S): Check<z.infer<S>> {
  return (parsed) => {
    const result = schema.safeParse(parsed);
    if (result.success) return { ok: true, value: result.data };
    const issues = result.error.issues.map((i) => `${i.path.length ? `«${i.path.join(".")}»: ` : ""}${i.message}`);
    return { ok: false, error: parsed === undefined || parsed === null ? "no llegó ninguna salida con el formato pedido" : issues.join("; ") };
  };
}

const MAX_ECHO_CHARS = 1500;

/** Lo que contestó el modelo, como texto: los argumentos de la herramienta de salida, o su texto. */
function answered(result: Awaited<ReturnType<StructuredModel["invoke"]>>): string {
  const raw = result?.raw;
  let text: string | undefined;
  if (raw && AIMessage.isInstance(raw as BaseMessage)) {
    const ai = raw as AIMessage;
    text = ai.tool_calls?.length ? JSON.stringify(ai.tool_calls[0]!.args) : ai.text;
  }
  text ??= result?.parsed !== undefined ? JSON.stringify(result.parsed) : "(nada)";
  return text.length > MAX_ECHO_CHARS ? `${text.slice(0, MAX_ECHO_CHARS)}…` : text;
}

/**
 * El pedido con la corrección agregada al ÚLTIMO mensaje de la persona (no como un mensaje aparte: la API de Claude
 * espera que se alternen persona e IA).
 */
function withCorrection(messages: BaseMessage[], correction: string): BaseMessage[] {
  const at = messages.findLastIndex((m) => HumanMessage.isInstance(m));
  if (at === -1) return [...messages, new HumanMessage(correction)];
  const copy = [...messages];
  copy[at] = new HumanMessage(`${messages[at]!.text}\n\n${correction}`);
  return copy;
}

export interface CorrectionResult<T> {
  /** El valor válido (del primer intento o del segundo), o `undefined` si ninguno sirvió. */
  value?: T;
  /** Hubo un segundo intento. */
  corrected: boolean;
  /** Por qué no sirvió el último intento (si no sirvió). */
  error?: string;
}

/**
 * Llama al modelo y valida; si no sirve, un segundo intento con la corrección. Un error real de la API no se atrapa:
 * sube como siempre (y lo reintenta LangChain antes).
 */
export async function invokeWithCorrection<T>(
  model: StructuredModel,
  messages: BaseMessage[],
  check: Check<T>,
  options: { warn?: (message: string) => void; label?: string } = {},
): Promise<CorrectionResult<T>> {
  const first = await model.invoke(messages);
  const firstCheck = check(first?.parsed);
  if (firstCheck.ok) return { value: firstCheck.value, corrected: false };

  options.warn?.(`[${options.label ?? "salida"}] Salida inválida (${firstCheck.error}): segundo intento con la corrección.`);
  const correction =
    "Tu respuesta anterior no cumplió el formato pedido, así que no se pudo usar.\n" +
    `Lo que contestaste: ${answered(first)}\n` +
    `Qué está mal: ${firstCheck.error}\n` +
    "Volvé a contestar lo mismo que se pidió arriba, con el formato pedido.";
  const second = await model.invoke(withCorrection(messages, correction));
  const secondCheck = check(second?.parsed);
  if (secondCheck.ok) return { value: secondCheck.value, corrected: true };
  return { corrected: true, error: secondCheck.error };
}
