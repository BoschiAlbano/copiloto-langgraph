import { getWriter, type LangGraphRunnableConfig } from "@langchain/langgraph";

/**
 * Lo que una lectura avisa mientras reintenta (fase 10, R2). Viaja por el modo `custom` de streaming de LangGraph: la
 * herramienta (o la sección del reporte) lo escribe con `getWriter()` y llega a la web y a la terminal mientras ocurre.
 */
export interface RetryNotice {
  kind: "retry";
  /** La herramienta (`getStockLevels`) o la sección del reporte (`section:stock`). */
  target: string;
  /** El intento que viene (2, 3…) y el total. */
  attempt: number;
  attempts: number;
}

/** Avisa un reintento si hay alguien escuchando (dentro de un grafo con el modo `custom`); si no, no hace nada. */
export function announceRetry(notice: Omit<RetryNotice, "kind">, config?: LangGraphRunnableConfig) {
  try {
    // Dentro de un nodo alcanza con getWriter(); una herramienta del ToolNode lo encuentra en la configuración que recibe.
    (config?.writer ?? getWriter(config))?.({ kind: "retry", ...notice } satisfies RetryNotice);
  } catch {
    // Fuera de un grafo (un test, un script) no hay a quién avisar.
  }
}
