import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { BusinessMemory } from "../../memory/context.js";
import { listMemories, MEMORY_NAMESPACE } from "../../memory/store.js";

/**
 * Primer nodo de cada turno (fase 8): lee las memorias del negocio del Store y las deja en `businessContext`.
 *
 * El Store no se le pasa al nodo a mano: se le da al grafo al compilar (`compile({ store })`) y LangGraph se lo
 * entrega a cada nodo en su configuración (`config.store`). A diferencia del checkpointer, no depende del
 * `thread_id`: lo que se guardó desde un hilo se lee acá desde cualquier otro.
 *
 * Sin Store (por ejemplo, en los tests de fases anteriores) no hay memorias y todo funciona como en la fase 7. Un error
 * del Store (la base caída) no se tapa: se propaga, como el de cualquier otra consulta, en vez de seguir sin las reglas.
 */
export function makeLoadMemoryNode({ namespace = MEMORY_NAMESPACE }: { namespace?: string[] } = {}) {
  return async (_state: unknown, config?: LangGraphRunnableConfig): Promise<{ businessContext: BusinessMemory[] }> => {
    const store = config?.store;
    if (!store) return { businessContext: [] };
    const memories = await listMemories({ store, namespace });
    return { businessContext: memories.map(({ id, kind, text }) => ({ id, kind, text })) };
  };
}
