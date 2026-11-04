import path from "node:path"
import { fileURLToPath } from "node:url"
import type { NextConfig } from "next"

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

// La app importa el copiloto desde ../src (el mismo código que usa la terminal). Ese código usa imports con `.js` que
// apuntan a archivos `.ts` (resolución NodeNext). Turbopack no los resuelve fuera de web/; webpack sí, con
// `extensionAlias`. Por eso los scripts usan `--webpack`.
const nextConfig: NextConfig = {
  // web/ tiene su propio package-lock.json, pero el código del servidor también vive en ../src.
  outputFileTracingRoot: repoRoot,
  // El indicador de desarrollo de Next, abajo a la derecha: abajo a la izquierda tapa la barra de hilos.
  devIndicators: { position: "bottom-right" },
  experimental: {
    // Compilar archivos de fuera de web/ (../src).
    externalDir: true,
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  },
  webpack: (config, { isServer }) => {
    // Los prompts se leen del disco con `new URL("../prompts/x.md", import.meta.url)`. Webpack, por defecto, convierte
    // ese patrón en un archivo publicado (/_next/static/media/…). En el servidor se apaga: la URL queda apuntando al
    // archivo real de src/, como cuando corre la terminal.
    if (isServer) {
      config.module.parser = {
        ...config.module.parser,
        javascript: { ...config.module.parser?.javascript, url: false },
      }
    }
    return config
  },
  // Paquetes del servidor que se cargan con Node tal cual, sin empaquetarlos (pools de Postgres, Prisma, LangGraph).
  serverExternalPackages: [
    "pg",
    "@prisma/client",
    "@prisma/adapter-pg",
    "@langchain/langgraph-checkpoint-postgres",
  ],
}

export default nextConfig
