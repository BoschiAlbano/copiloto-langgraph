import { defineConfig } from "vitest/config";

// Tests que escriben en la base (acciones aprobadas): un archivo por vez, después del resto de la suite.
// Cada uno crea sus propios datos de prueba y los borra al terminar.
export default defineConfig({
  test: { include: ["tests/writes/**/*.test.ts"], fileParallelism: false },
});
