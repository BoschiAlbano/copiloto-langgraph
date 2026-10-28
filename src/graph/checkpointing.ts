import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

/** Esquema de Postgres donde LangGraph guarda los hilos, aparte de las tablas del negocio. */
export const CHECKPOINT_SCHEMA = "langgraph";

export interface Checkpointing {
  /** Lo que se le pasa a `compile({ checkpointer })`. */
  saver: PostgresSaver;
  /** El mismo pool, para las consultas propias (listar hilos). */
  pool: pg.Pool;
  close: () => Promise<void>;
}

/** Conecta con el rol copilot_checkpointer. Las tablas ya existen: las crea `npm run db:checkpoints`. */
export function createCheckpointing(url: string): Checkpointing {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  // Sin este oyente, una conexión ociosa que se cae tumba el proceso entero.
  pool.on("error", (error) => console.warn(`[checkpointer] conexión ociosa caída: ${error.message}`));
  const saver = new PostgresSaver(pool, undefined, { schema: CHECKPOINT_SCHEMA });
  return { saver, pool, close: () => pool.end() };
}
