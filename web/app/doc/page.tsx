import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRightIcon, BookOpenIcon, ClockIcon, MapIcon, NetworkIcon, WorkflowIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { getRegistry, loadAll } from "@/lib/docs"
import { shortTitle } from "@/lib/docs-core"

export const dynamic = "force-dynamic"
export const metadata: Metadata = { title: "Documentación · Copiloto" }

/** La portada de la documentación (R1): qué es el proyecto y una tarjeta por fase. */
export default async function DocHome() {
  const docs = await loadAll(await getRegistry())
  const phases = docs.filter((d) => d.entry.group === "phase")
  const done = phases.filter((d) => d.meta.status === "terminada").length
  const diagrams = docs.reduce((n, d) => n + d.meta.diagrams, 0)
  const reference = docs.filter((d) => d.entry.group !== "phase")

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-12 px-4 py-10 sm:px-8">
      <section className="flex flex-col gap-5">
        <Badge variant="secondary" className="w-fit">
          Spec-driven development · LangGraph.js
        </Badge>
        <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Copiloto de gestión para una barbería, construido fase por fase</h1>
        <p className="max-w-3xl text-base leading-relaxed text-muted-foreground text-pretty">
          Cada fase agrega un concepto de LangGraph (herramientas, router, persistencia, aprobación humana, paralelismo, subgrafos, memoria, streaming) y tiene su spec: qué se pidió, cómo se diseñó, los diagramas, qué se decidió en el camino y qué se aprendió. Leelas en orden para estudiar cómo crece el grafo.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button nativeButton={false} render={<Link href="/doc/fase-01" />}>
            <BookOpenIcon data-icon="inline-start" />
            Empezar por la fase 1
          </Button>
          <Button variant="outline" nativeButton={false} render={<Link href="/doc/plan" />}>
            <MapIcon data-icon="inline-start" />
            El plan completo
          </Button>
          <Button variant="outline" nativeButton={false} render={<Link href="/doc/mapa-del-grafo" />}>
            <NetworkIcon data-icon="inline-start" />
            Mapa del grafo
          </Button>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Fases terminadas</dt>
            <dd className="font-medium tabular-nums">
              {done} de {phases.length}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Diagramas</dt>
            <dd className="font-medium tabular-nums">{diagrams}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Lectura total</dt>
            <dd className="font-medium tabular-nums">~{docs.reduce((n, d) => n + d.meta.readingMinutes, 0)} min</dd>
          </div>
        </dl>
      </section>

      <section className="flex flex-col gap-5" aria-labelledby="fases">
        <h2 id="fases" className="text-xl font-semibold tracking-tight">
          Las fases
        </h2>
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {phases.map(({ entry, meta }) => (
            <li key={entry.slug} className="flex">
              <Card className="relative w-full transition-colors hover:border-primary/40">
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="outline" className="tabular-nums">
                      {entry.label}
                    </Badge>
                    {meta.status && <Badge variant={meta.status === "terminada" ? "secondary" : "default"}>{meta.status}</Badge>}
                  </div>
                  <CardTitle className="mt-2 text-base">
                    <Link href={`/doc/${entry.slug}`} className="after:absolute after:inset-0 hover:underline hover:underline-offset-3">
                      {shortTitle(meta.title)}
                    </Link>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex-1">
                  <CardDescription className="line-clamp-4 leading-relaxed">{meta.objective}</CardDescription>
                </CardContent>
                <CardFooter className="gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <WorkflowIcon className="size-3.5" aria-hidden />
                    {meta.diagrams} {meta.diagrams === 1 ? "diagrama" : "diagramas"}
                  </span>
                  <span className="flex items-center gap-1">
                    <ClockIcon className="size-3.5" aria-hidden />
                    {meta.readingMinutes} min
                  </span>
                </CardFooter>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-5" aria-labelledby="referencia">
        <h2 id="referencia" className="text-xl font-semibold tracking-tight">
          Para consultar
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {reference.map(({ entry, meta }) => (
            <li key={entry.slug}>
              <Link
                href={`/doc/${entry.slug}`}
                className="group flex items-center justify-between gap-4 rounded-xl border bg-card p-4 transition-colors outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium">{entry.label}</span>
                  <span className="truncate text-sm text-muted-foreground">{meta.title}</span>
                </span>
                <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
