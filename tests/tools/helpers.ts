import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { loadEnvFile } from "../../src/config/env.js";
import { createPrisma, type Db } from "../../src/db/client.js";

loadEnvFile();

/** URL del rol de lectura: los tests de herramientas usan el mismo rol que el agente. */
export const readUrl = process.env.DATABASE_URL_READ;
export const hasDb = Boolean(readUrl && process.env.DATABASE_URL_WRITE);

/**
 * Prepara dos conexiones para un `describe`: `db` (Prisma con el rol de lectura, lo que usa
 * el agente) y `sql` (pg con el rol de escritura, para calcular el resultado esperado
 * con una consulta independiente).
 */
export function useDatabases() {
  const ctx = {} as { db: Db; sql: pg.Client };
  beforeAll(async () => {
    ctx.db = createPrisma(readUrl!);
    ctx.sql = new pg.Client({ connectionString: process.env.DATABASE_URL_WRITE });
    await ctx.sql.connect();
  });
  afterAll(async () => {
    await ctx.db.$disconnect();
    await ctx.sql.end();
  });
  return ctx;
}
