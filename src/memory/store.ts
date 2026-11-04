import { randomBytes } from "node:crypto";
import type { BaseStore } from "@langchain/langgraph";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { z } from "zod";
import { CHECKPOINT_SCHEMA } from "../graph/checkpointing.js";

// La memoria de largo plazo (fase 8): un Store de LangGraph. A diferencia del checkpointer, que guarda el estado de
// UN hilo (por thread_id), el Store guarda datos por namespace y clave, y cualquier hilo los lee.

/** Dónde viven las memorias del negocio. Un solo negocio, sin usuarios: un solo namespace. */
export const MEMORY_NAMESPACE = ["negocio", "memorias"];

export const MEMORY_KINDS = ["rule", "preference"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Lo que se guarda en el Store como valor de cada memoria. */
const memoryValueSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  text: z.string().min(1),
  /** ISO 8601. */
  createdAt: z.string(),
  /** El hilo en que se dictó. */
  threadId: z.string().optional(),
});

export const memorySchema = memoryValueSchema.extend({ id: z.string().min(1) });
export type Memory = z.infer<typeof memorySchema>;

/** El Store y el namespace de las memorias. Los tests usan un namespace propio para no tocar las memorias reales. */
export interface MemoryBank {
  store: BaseStore;
  namespace: string[];
}

/** Un id corto y legible para borrar desde la terminal («npm run memory -- delete 3f2a9c»). */
const newMemoryId = () => randomBytes(3).toString("hex");

/** Todas las memorias, de la más vieja a la más nueva. Un valor que no cumple el esquema se ignora. */
export async function listMemories({ store, namespace }: MemoryBank): Promise<Memory[]> {
  const items = await store.search(namespace, { limit: 100 });
  const memories: Memory[] = [];
  for (const item of items) {
    const parsed = memoryValueSchema.safeParse(item.value);
    if (parsed.success) memories.push({ id: item.key, ...parsed.data });
  }
  return memories.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Guarda una memoria YA validada (`checkMemory`) y la devuelve con su id. */
export async function saveMemory(
  { store, namespace }: MemoryBank,
  memory: { kind: MemoryKind; text: string; threadId?: string },
  now: Date = new Date(),
): Promise<Memory> {
  const id = newMemoryId();
  const value = { kind: memory.kind, text: memory.text, createdAt: now.toISOString(), ...(memory.threadId && { threadId: memory.threadId }) };
  // `false`: sin índice de búsqueda semántica (fuera de alcance: con 30 memorias como máximo se cargan todas).
  await store.put(namespace, id, value, false);
  return { id, ...value };
}

/** Borra una memoria. Devuelve la que se borró, o undefined si no existía. */
export async function deleteMemory({ store, namespace }: MemoryBank, id: string): Promise<Memory | undefined> {
  const item = await store.get(namespace, id);
  if (!item) return undefined;
  const parsed = memoryValueSchema.safeParse(item.value);
  await store.delete(namespace, id);
  return parsed.success ? { id, ...parsed.data } : undefined;
}

/** Borra todas las memorias del namespace. Devuelve cuántas borró. */
export async function clearMemories(bank: MemoryBank): Promise<number> {
  const items = await bank.store.search(bank.namespace, { limit: 1000 });
  for (const item of items) await bank.store.delete(bank.namespace, item.key);
  return items.length;
}

/**
 * El Store de Postgres de la aplicación, en el esquema de los hilos y con el rol copilot_checkpointer. No crea tablas
 * (`ensureTables: false`): ese rol no puede, y las crea `npm run db:checkpoints` con el dueño de la base.
 */
export function createMemoryStore(url: string, { maxConnections = 2 } = {}): PostgresStore {
  return new PostgresStore({ connectionOptions: { connectionString: url, max: maxConnections }, schema: CHECKPOINT_SCHEMA, ensureTables: false });
}
