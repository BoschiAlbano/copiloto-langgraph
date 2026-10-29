// Las cifras de un texto, para comprobar que la «Lectura» del modelo no inventó ninguna.

/** Todos los números que aparecen en el texto, sin separadores de miles ni decimales: «$ 1.569.100» → «1569100». */
export function numbersIn(text: string): string[] {
  const found = text.match(/\d[\d.,]*/g) ?? [];
  return found.map((token) => token.replace(/[.,]+$/g, "").replace(/[.,]/g, "")).filter(Boolean);
}

/** Los números de `candidate` que no aparecen en `source`. Si la lista vuelve vacía, no inventó ninguno. */
export function unknownNumbers(candidate: string, source: string): string[] {
  const allowed = new Set(numbersIn(source));
  return [...new Set(numbersIn(candidate).filter((n) => !allowed.has(n)))];
}
