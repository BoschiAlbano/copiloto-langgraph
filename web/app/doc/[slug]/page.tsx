import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon, ArrowRightIcon, ClockIcon, WorkflowIcon } from "lucide-react"
import { DocMarkdown } from "@/components/doc/doc-markdown"
import { DocToc } from "@/components/doc/doc-toc"
import { Badge } from "@/components/ui/badge"
import { getRegistry, loadDoc } from "@/lib/docs"
import { extractToc, neighbors, shortTitle, type DocEntry } from "@/lib/docs-core"

export const dynamic = "force-dynamic"

const GROUP_LABELS: Record<DocEntry["group"], string> = { intro: "Empezar", phase: "Fases", reference: "Referencia" }

export async function generateMetadata({ params }: PageProps<"/doc/[slug]">): Promise<Metadata> {
  const { slug } = await params
  const doc = await loadDoc(await getRegistry(), slug)
  return { title: doc ? `${doc.meta.title} · Documentación` : "Documentación" }
}

/** Un documento (R2): el texto de lectura, el índice y anterior/siguiente. Fuera de la lista, 404 (R6). */
export default async function DocPage({ params }: PageProps<"/doc/[slug]">) {
  const { slug } = await params
  const registry = await getRegistry()
  const doc = await loadDoc(registry, slug)
  if (!doc) notFound()
  const { entry, markdown, meta } = doc
  // El título va arriba, con los datos del documento: se saca del texto para no repetirlo.
  const body = markdown.replace(/^﻿?#\s+.*\r?\n/, "").replace(/^\s*Estado:.*\r?\n/m, "")
  const toc = extractToc(markdown)
  const { previous, next } = neighbors(registry, slug)

  return (
    <div className="mx-auto flex w-full max-w-7xl gap-10 px-4 py-10 sm:px-8">
      <article className="min-w-0 flex-1">
        <header className="mb-8 flex flex-col gap-3 border-b pb-6">
          <p className="text-sm text-muted-foreground">
            {GROUP_LABELS[entry.group]}
            {entry.phase !== undefined && ` · ${entry.label}`}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance">{entry.group === "phase" ? shortTitle(meta.title) : meta.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {meta.status && <Badge variant={meta.status === "terminada" ? "secondary" : "default"}>{meta.status}</Badge>}
            <span className="flex items-center gap-1">
              <ClockIcon className="size-3.5" aria-hidden />
              {meta.readingMinutes} min de lectura
            </span>
            {meta.diagrams > 0 && (
              <span className="flex items-center gap-1">
                <WorkflowIcon className="size-3.5" aria-hidden />
                {meta.diagrams} {meta.diagrams === 1 ? "diagrama" : "diagramas"}
              </span>
            )}
          </div>
        </header>

        <DocMarkdown markdown={body} registry={registry} />

        <nav aria-label="Anterior y siguiente" className="mt-14 grid gap-3 border-t pt-6 sm:grid-cols-2">
          {previous ? (
            <Link href={`/doc/${previous.slug}`} className="group flex flex-col gap-1 rounded-xl border p-4 transition-colors outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <ArrowLeftIcon className="size-3.5" aria-hidden />
                Anterior
              </span>
              <span className="font-medium">{previous.label}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={`/doc/${next.slug}`} className="group flex flex-col items-end gap-1 rounded-xl border p-4 text-right transition-colors outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                Siguiente
                <ArrowRightIcon className="size-3.5" aria-hidden />
              </span>
              <span className="font-medium">{next.label}</span>
            </Link>
          )}
        </nav>
      </article>
      <aside className="hidden w-60 shrink-0 xl:block">
        <div className="sticky top-24 max-h-[calc(100svh-8rem)] overflow-y-auto pb-6">
          <DocToc items={toc} />
        </div>
      </aside>
    </div>
  )
}
