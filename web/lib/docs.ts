import "server-only"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { buildRegistry, findDoc, parseMeta, type DocEntry, type DocMeta } from "./docs-core"

// La lectura de los documentos desde el repositorio (R5): en cada pedido, para que la web muestre lo mismo que está
// en `specs/`. `npm run web` corre con cwd en web/: la raíz del repositorio es la carpeta de arriba.
const repoRoot = () => path.join(process.cwd(), "..")

export async function getRegistry(): Promise<DocEntry[]> {
  const specs = await readdir(path.join(repoRoot(), "specs"))
  return buildRegistry(specs)
}

export interface LoadedDoc {
  entry: DocEntry
  markdown: string
  meta: DocMeta
}

/** Un documento por su slug, o `undefined` si no está en la lista. El archivo sale de la lista, nunca del slug (R6). */
export async function loadDoc(registry: DocEntry[], slug: string): Promise<LoadedDoc | undefined> {
  const entry = findDoc(registry, slug)
  if (!entry) return undefined
  const markdown = await readFile(path.join(repoRoot(), entry.file), "utf8")
  return { entry, markdown, meta: parseMeta(markdown, entry.label) }
}

/** Todos los documentos con sus metadatos (para la portada y la barra lateral). */
export async function loadAll(registry: DocEntry[]): Promise<LoadedDoc[]> {
  return Promise.all(registry.map((d) => loadDoc(registry, d.slug) as Promise<LoadedDoc>))
}
