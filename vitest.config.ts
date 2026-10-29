import { defineConfig } from "vitest/config";

// `npm test` corre dos etapas: esta (todo salvo tests/writes, en paralelo) y después tests/writes en serie
// (vitest.writes.config.ts). Los tests que escriben en la base no pueden convivir con los que cuentan datos.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/writes/**", "node_modules/**"] },
});
