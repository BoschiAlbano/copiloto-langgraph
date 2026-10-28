// USD por millón de tokens, según el plan (octubre de 2026). Confirmar en la consola de la API.
// Haiku 5.5 vale así para prompts de hasta 100.000 tokens. No se descuenta el caché de prompts.
export const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

/** Costo estimado en USD, o null si no conocemos el precio del modelo. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES_PER_MTOK[model];
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
