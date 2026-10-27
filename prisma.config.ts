import { existsSync } from "node:fs";
import { defineConfig, env } from "prisma/config";

// Prisma 7 ya no carga .env solo.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Las migraciones usan el rol con permisos de escritura.
  datasource: { url: env("DATABASE_URL_WRITE") },
});
