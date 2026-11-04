import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Lee un prompt versionado. Recibe la URL ya armada con `new URL("../prompts/x.md", import.meta.url)` en el módulo que
 * lo usa (así cada prompt se resuelve desde su archivo). Se pasa por `href`: dentro de la app web (webpack), la URL
 * llega como un objeto de otro contexto que `readFileSync` no acepta; el texto de la URL vale en los dos lados.
 */
export function readPrompt(url: URL): string {
  return readFileSync(fileURLToPath(url.href), "utf8");
}
