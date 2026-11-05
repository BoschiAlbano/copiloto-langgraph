import Link from "next/link"
import { ArrowDownIcon, ArrowLeftIcon, ArrowUpIcon, MinusIcon } from "lucide-react"
import type { EvalRunSummary, RunComparison } from "@copilot/web/handlers"
import { percent } from "@copilot/observability/eval-report"
import { CategoryBar } from "@/components/observability/category-bar"
import { ObsMain } from "@/components/observability/obs-header"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { buttonVariants } from "@/components/ui/button"
import { getHandlers } from "@/lib/agent"
import { usd } from "@/lib/format"
import { when } from "@/lib/observability"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

function RunCard({ tag, run }: { tag: string; run: EvalRunSummary }) {
  return (
    <Link href={`/evals/${run.id}`} className="flex min-w-0 flex-1 flex-col gap-1 rounded-xl border p-4 transition-colors hover:bg-muted/40">
      <span className="text-xs text-muted-foreground">{tag}</span>
      <span className="truncate font-medium">{run.label ?? "Corrida sin nombre"}</span>
      <span className="truncate text-xs text-muted-foreground">
        {when(run.startedAt)} · prompts {run.prompts} · {run.models.agent}
      </span>
      <span className="text-sm tabular-nums">
        {run.passed}/{run.total} · {percent(run.passed, run.total)}
      </span>
    </Link>
  )
}

const signed = (n: number) => (n > 0 ? `+${n.toLocaleString("es-AR")}` : n.toLocaleString("es-AR"))

// Comparar dos corridas (fase 11, R13 y R14): por categoría, los casos que cambiaron y la diferencia de costo.
export default async function ComparePage({ searchParams }: PageProps<"/evals/compare">) {
  const params = await searchParams
  const url = new URL("http://local/api/evals/compare")
  for (const key of ["a", "b"]) if (typeof params[key] === "string") url.searchParams.set(key, params[key])
  const response = await getHandlers().compareEvals(url)
  const body = (await response.json()) as RunComparison | { error: string }

  return (
    <ObsMain>
      <Link href="/evals" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2 w-fit gap-1.5 text-muted-foreground")}>
        <ArrowLeftIcon />
        Todas las corridas
      </Link>
      {"error" in body ? (
        <Alert variant="destructive">
          <AlertTitle>No se pudieron comparar</AlertTitle>
          <AlertDescription>{body.error}</AlertDescription>
        </Alert>
      ) : (
        <>
          <h1 className="text-xl font-semibold tracking-tight">Comparación</h1>
          <div className="flex flex-col gap-3 sm:flex-row">
            <RunCard tag="Antes (A)" run={body.a} />
            <RunCard tag="Después (B)" run={body.b} />
          </div>

          <section className="flex flex-col gap-3" aria-labelledby="cambios">
            <h2 id="cambios" className="text-sm font-medium">
              Casos que cambiaron
            </h2>
            {body.changed.length === 0 ? (
              <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
                Ningún caso cambió de forma estable{body.a.runs > 1 || body.b.runs > 1 ? " (en la mayoría de las corridas)" : ""}.
              </p>
            ) : (
              <ul className="flex flex-col overflow-hidden rounded-xl border" data-testid="eval-changed">
                {body.changed.map((c) => (
                  <li key={c.caseId} className="flex items-start gap-3 border-b px-4 py-2.5 last:border-b-0">
                    {c.direction === "mejoró" ? (
                      <ArrowUpIcon aria-label="mejoró" className="mt-0.5 size-4 shrink-0 text-primary" />
                    ) : (
                      <ArrowDownIcon aria-label="empeoró" className="mt-0.5 size-4 shrink-0 text-destructive" />
                    )}
                    <span className="w-8 shrink-0 font-mono text-xs font-medium leading-5">{c.caseId}</span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm">
                        {c.direction} · {c.a.passes}/{c.a.runs} → {c.b.passes}/{c.b.runs}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {c.category}
                        {c.direction === "empeoró" && c.b.failures[0] && ` · ${c.b.failures[0]}`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-3" aria-labelledby="categorias">
            <h2 id="categorias" className="text-sm font-medium">
              Por categoría
            </h2>
            <div className="flex flex-col gap-3 rounded-xl border p-4" data-testid="eval-compare-categories">
              {body.categories.map((c) => (
                <div key={c.category} className="grid items-center gap-x-4 gap-y-1 sm:grid-cols-[12rem_1fr_1fr_1.5rem]">
                  <span className="text-sm">{c.category}</span>
                  <CategoryBar passed={c.a.passed} total={c.a.total} className="opacity-60" />
                  <CategoryBar passed={c.b.passed} total={c.b.total} />
                  <span className="hidden justify-self-end sm:block">
                    {c.b.passed > c.a.passed ? (
                      <ArrowUpIcon aria-label="mejoró" className="size-4 text-primary" />
                    ) : c.b.passed < c.a.passed ? (
                      <ArrowDownIcon aria-label="empeoró" className="size-4 text-destructive" />
                    ) : (
                      <MinusIcon aria-label="igual" className="size-4 text-muted-foreground" />
                    )}
                  </span>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">En cada fila, la barra de la izquierda (más clara) es A y la de la derecha, B.</p>
            </div>
          </section>

          <p className="text-sm text-muted-foreground">
            Por caso, B usa {signed(body.delta.inputTokens)} tokens de entrada y {signed(body.delta.outputTokens)} de salida respecto de A
            {body.delta.costUsd !== null && ` (${body.delta.costUsd >= 0 ? "+" : "−"}${usd(Math.abs(body.delta.costUsd))})`}.
          </p>
        </>
      )}
    </ObsMain>
  )
}
