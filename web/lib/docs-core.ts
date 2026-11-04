import GithubSlugger from "github-slugger"

// La documentación del proyecto en la web (`/doc`, ver specs/doc-web.md). Funciones puras: qué documentos hay, qué
// dice cada uno (título, estado, objetivo) y su índice. Sin acceso a disco, para probarlas con vitest; la lectura de
// los archivos está en `docs.ts`.

export type DocGroup = "intro" | "phase" | "reference"

export interface DocEntry {
  /** Lo que va en la dirección: `/doc/<slug>`. */
  slug: string
  /** Ruta del archivo, relativa a la raíz del repositorio. Sale de la lista: nunca de la dirección. */
  file: string
  group: DocGroup
  /** Número de fase (solo las fases). */
  phase?: number
  /** Nombre corto para la navegación. */
  label: string
}

export const PLAN_FILE = "doc/Plan Copiloto de gestión con LangGraph (SDD).md"
const PHASE_FILE = /^fase-(\d{2})-[a-z0-9-]+\.md$/

/**
 * La lista de documentos: los fijos y las fases que haya en `specs/` (una spec nueva aparece sola, R2).
 * `specFiles` son los nombres de archivo de `specs/`.
 */
export function buildRegistry(specFiles: string[]): DocEntry[] {
  const phases = specFiles
    .map((name) => ({ name, match: PHASE_FILE.exec(name) }))
    .filter((f): f is { name: string; match: RegExpExecArray } => f.match !== null)
    .map(({ name, match }) => ({ name, phase: Number(match[1]) }))
    .sort((a, b) => a.phase - b.phase)
    .map(({ name, phase }): DocEntry => ({ slug: `fase-${String(phase).padStart(2, "0")}`, file: `specs/${name}`, group: "phase", phase, label: `Fase ${phase}` }))
  const reference: DocEntry[] = [{ slug: "mapa-del-grafo", file: "specs/mapa-del-grafo.md", group: "reference", label: "Mapa del grafo" }]
  if (specFiles.includes("doc-web.md")) reference.push({ slug: "doc-web", file: "specs/doc-web.md", group: "reference", label: "Esta documentación" })
  return [
    { slug: "inicio", file: "README.md", group: "intro", label: "Inicio" },
    { slug: "plan", file: PLAN_FILE, group: "intro", label: "Plan del proyecto" },
    ...phases,
    ...reference,
  ]
}

/** El título sin el «Fase N:», para la navegación y las tarjetas. */
export const shortTitle = (title: string) => title.replace(/^Fase \d+:\s*/, "")

export const findDoc = (registry: DocEntry[], slug: string) => registry.find((d) => d.slug === slug)

/** Saca lo que no es texto de una línea de Markdown: código, énfasis y links (se queda con el texto del link). */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/__([^_]+)__/g, "$1")
    .trim()
}

/** Las líneas de un documento con una marca de si están dentro de un bloque de código (``` … ```). */
function linesOutsideCode(markdown: string): string[] {
  const out: string[] = []
  let inCode = false
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode
      continue
    }
    if (!inCode) out.push(line)
  }
  return out
}

export interface DocMeta {
  title: string
  /** «terminada», «en curso», «borrador»… si el documento tiene una línea `Estado:`. */
  status?: string
  /** El primer párrafo de «## Objetivo», si lo hay. */
  objective?: string
  diagrams: number
  readingMinutes: number
}

export function parseMeta(markdown: string, fallbackTitle: string): DocMeta {
  const lines = linesOutsideCode(markdown)
  const title = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, "").trim()
  const statusLine = lines.find((l) => /^Estado:\s*/.test(l))
  const status = statusLine ? /\*\*([^*]+)\*\*/.exec(statusLine)?.[1]?.trim() : undefined
  let objective: string | undefined
  const at = lines.findIndex((l) => /^##\s+Objetivo\s*$/.test(l))
  if (at !== -1) {
    const paragraph: string[] = []
    for (const line of lines.slice(at + 1)) {
      if (/^#/.test(line)) break
      if (!line.trim()) {
        if (paragraph.length) break
        continue
      }
      paragraph.push(line.trim())
    }
    if (paragraph.length) objective = plainText(paragraph.join(" "))
  }
  const diagrams = (markdown.match(/^\s*```mermaid\s*$/gm) ?? []).length
  const words = markdown.split(/\s+/).filter(Boolean).length
  return { title: title ? plainText(title) : fallbackTitle, status, objective, diagrams, readingMinutes: Math.max(1, Math.round(words / 200)) }
}

export interface TocItem {
  depth: 2 | 3
  text: string
  /** El id que `rehype-slug` le pone al título (el mismo algoritmo: github-slugger, en orden). */
  id: string
}

/** El índice «En esta página»: los títulos `##` y `###`, con los mismos ids que les pone rehype-slug. */
export function extractToc(markdown: string): TocItem[] {
  const slugger = new GithubSlugger()
  const toc: TocItem[] = []
  for (const line of linesOutsideCode(markdown)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) continue
    const depth = match[1]!.length
    const text = plainText(match[2]!)
    // Todos los títulos pasan por el slugger (también el # y los ####): así los repetidos llevan el mismo sufijo.
    const id = slugger.slug(text)
    if (depth === 2 || depth === 3) toc.push({ depth, text, id })
  }
  return toc
}

/**
 * Un link de un documento a otro (`specs/fase-04-persistencia.md`, `../README.md#comandos`) se convierte en su
 * página de `/doc`. Los demás links quedan como están.
 */
export function rewriteDocLink(href: string, registry: DocEntry[]): string {
  if (/^[a-z]+:/i.test(href) || href.startsWith("#") || href.startsWith("/doc")) return href
  const [path = "", hash] = href.split("#")
  let base: string
  try {
    base = decodeURIComponent(path.split("/").pop() ?? "")
  } catch {
    return href
  }
  if (!base.toLowerCase().endsWith(".md")) return href
  const entry = registry.find((d) => d.file.split("/").pop() === base)
  if (!entry) return href
  return `/doc/${entry.slug}${hash ? `#${hash}` : ""}`
}

/** El documento anterior y el siguiente, en el orden de la lista (para estudiar fase por fase). */
export function neighbors(registry: DocEntry[], slug: string): { previous?: DocEntry; next?: DocEntry } {
  const at = registry.findIndex((d) => d.slug === slug)
  if (at === -1) return {}
  return { previous: registry[at - 1], next: registry[at + 1] }
}
