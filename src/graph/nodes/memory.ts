import { readPrompt } from "../prompts/read.js";
import { invokeWithCorrection, zodCheck } from "../structured.js";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import type { BusinessMemory } from "../../memory/context.js";
import { checkMemory } from "../../memory/rules.js";
import { deleteMemory, listMemories, MEMORY_KINDS, MEMORY_NAMESPACE, saveMemory, type Memory } from "../../memory/store.js";
import { sharedTask, type TaskState } from "../plan.js";
import type { RouterModel } from "./router.js";

// El agente de memoria (fase 8): un modelo barato decide QUÉ hacer (guardar, listar o borrar) y, al guardar, escribe la
// memoria en una frase. Todo lo demás es código: los controles de qué no se guarda, la escritura en el Store y la
// respuesta a la persona (así lo que se le dice es lo que de verdad quedó guardado).

/** Lo que devuelve el modelo de memoria (salida estructurada). */
export const memoryOutputSchema = z.object({
  operation: z.enum(["save", "list", "delete"]).describe("save: anotar una memoria; list: mostrar las que hay; delete: borrar una"),
  kind: z.enum(MEMORY_KINDS).optional().describe("Solo al guardar. rule: una regla del negocio; preference: cómo quiere que le contesten"),
  text: z.string().max(400).optional().describe("Solo al guardar: la memoria en una frase corta, clara y en presente"),
  memoryId: z.string().optional().describe("Solo al borrar: el id de la memoria a borrar, de la lista recibida. Vacío si no está claro cuál"),
});
export type MemoryOutput = z.infer<typeof memoryOutputSchema>;

/** El modelo de memoria: igual que el router, algo que devuelve `{ parsed }`. */
export type MemoryModel = RouterModel;

const memoryPrompt = readPrompt(new URL("../prompts/memory.md", import.meta.url));

const KIND_LABEL = { rule: "regla", preference: "preferencia" } as const;

/** La lista de memorias tal como se le muestra a la persona. */
export function describeMemories(memories: Pick<Memory, "id" | "kind" | "text">[]): string {
  if (memories.length === 0) return "No tengo reglas ni preferencias anotadas.";
  const section = (kind: (typeof MEMORY_KINDS)[number], title: string) => {
    const items = memories.filter((m) => m.kind === kind);
    return items.length ? [title, ...items.map((m) => `- ${m.text} (id ${m.id})`)] : [];
  };
  return [
    `Tengo ${memories.length === 1 ? "anotada 1 memoria" : `anotadas ${memories.length} memorias`}:`,
    ...section("rule", "Reglas del negocio:"),
    ...section("preference", "Preferencias:"),
  ].join("\n");
}

export const MEMORY_UNAVAILABLE = "La memoria de largo plazo no está disponible en este momento: no anoté ni borré nada.";
export const MEMORY_NOT_UNDERSTOOD =
  "No entendí qué querés que haga con la memoria. Puedo anotar una regla o una preferencia, mostrarte las que tengo o borrar una.";

export interface MemoryNodeOptions {
  namespace?: string[];
  /** Nombres completos de los clientes, para no guardar datos de clientes (se leen con el rol de lectura). */
  clientNames?: () => Promise<string[]>;
  now?: () => Date;
  warn?: (message: string) => void;
}

const toBusiness = (memories: Memory[]): BusinessMemory[] => memories.map(({ id, kind, text }) => ({ id, kind, text }));

/** Sin modelo o sin Store (por ejemplo, en tests de fases anteriores) la memoria no está disponible: no se hace nada. */
export function makeMemoryNode(model: MemoryModel | undefined, options: MemoryNodeOptions = {}) {
  const namespace = options.namespace ?? MEMORY_NAMESPACE;
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message: string) => console.warn(message));
  return async (state: TaskState, config?: LangGraphRunnableConfig) => {
    const reply = (text: string, memories?: Memory[]) => ({
      messages: [new AIMessage(text)],
      // Se actualiza `businessContext`: lo que se anotó ya vale para las tareas siguientes del mismo turno.
      ...(memories && { businessContext: toBusiness(memories) }),
    });
    const store = config?.store;
    if (!store || !model) return reply(MEMORY_UNAVAILABLE);
    const bank = { store, namespace };
    const current = await listMemories(bank);

    // El pedido: la parte que le toca (si el turno tiene varias) o el último mensaje de la persona.
    const request = sharedTask(state)?.request ?? state.messages.findLast((m) => HumanMessage.isInstance(m))?.text ?? "";
    // Fase 10: un segundo intento con la corrección si la salida no cumple el esquema; si tampoco, se informa.
    const { value } = await invokeWithCorrection(
      model,
      [
        new SystemMessage(memoryPrompt),
        new HumanMessage(
          `Memorias anotadas (id: tipo · texto):\n${current.map((m) => `${m.id}: ${m.kind} · ${m.text}`).join("\n") || "(ninguna)"}\n\nPedido de la persona: «${request}»`,
        ),
      ],
      zodCheck(memoryOutputSchema),
      { warn, label: "memoria" },
    );
    if (!value) {
      warn("[memoria] Salida inválida del modelo también en el segundo intento: no se hizo nada.");
      return reply(MEMORY_NOT_UNDERSTOOD);
    }
    const { operation, kind, text, memoryId } = value;

    if (operation === "list") return reply(describeMemories(current), current);

    if (operation === "delete") {
      const target = current.find((m) => m.id === memoryId);
      if (!target) {
        return reply(current.length ? `¿Cuál querés que borre? ${describeMemories(current)}` : "No tengo nada anotado para borrar.", current);
      }
      await deleteMemory(bank, target.id);
      return reply(`Borré esta ${KIND_LABEL[target.kind]}: «${target.text}».`, current.filter((m) => m.id !== target.id));
    }

    if (!kind || !text) return reply(MEMORY_NOT_UNDERSTOOD, current);
    const check = checkMemory(text, { clientNames: await (options.clientNames?.() ?? Promise.resolve([])), existing: current.map((m) => m.text) });
    if (!check.ok) return reply(`No lo anoté: ${check.reason}`, current);
    const threadId = config?.configurable?.thread_id;
    const saved = await saveMemory(bank, { kind, text: check.text, ...(typeof threadId === "string" && { threadId }) }, now());
    return reply(`Anoté esta ${KIND_LABEL[kind]}: «${saved.text}». La voy a tener en cuenta en todas las conversaciones.`, [...current, saved]);
  };
}
