import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, WaypointsIcon, XIcon } from "lucide-react"
import type { EvalRun } from "@copilot/web/handlers"
import { byCase, byCategory, EVAL_CATEGORIES, percent } from "@copilot/observability/eval-report"
import { formatDuration } from "@copilot/web/trace-view"
import { CategoryBar } from "@/components/observability/category-bar"
import { ObsMain } from "@/components/observability/obs-header"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { getHandlers } from "@/lib/agent"
import { tokens, usd } from "@/lib/format"
import { when } from "@/lib/observability"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border px-3 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  )
}

// El informe de una corrida (fase 11, R14): aciertos por categoría y cada caso, con lo que falló y su traza.
export default async function EvalRunPage({ params }: PageProps<"/evals/[id]">) {
  const { id } = await params
  const response = await getHandlers().getEval(id)
  if (response.status === 400 || response.status === 404) notFound()
  if (!response.ok) throw new Error("No se pudo leer la corrida.")
  const run = (await response.json()) as EvalRun
  const categories = byCategory(run.results, EVAL_CATEGORIES)
  const cases = byCase(run.results)
  const order = new Map<string, number>(EVAL_CATEGORIES.map((c, i) => [c, i]))
  cases.sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || a.caseId.localeCompare(b.caseId, "es", { numeric: true }))
  const runsOf = (caseId: string) => run.results.filter((r) => r.caseId === caseId).sort((a, b) => a.runNo - b.runNo)

  return (
    <ObsMain>
      <div className="flex flex-col gap-3">
        <Link href="/evals" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2 w-fit gap-1.5 text-muted-foreground")}>
          <ArrowLeftIcon />
          Todas las corridas
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={run.passed === run.total ? "secondary" : "outline"}>
            {run.passed}/{run.total} · {percent(run.passed, run.total)}
          </Badge>
          <Badge variant="outline">prompts {run.prompts}</Badge>
          <span className="text-xs text-muted-foreground">{when(run.startedAt)}</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{run.label ?? "Corrida sin nombre"}</h1>
        <p className="font-mono text-xs text-muted-foreground">
          agente {run.models.agent} · router {run.models.router} · reporte {run.models.report}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Casos" value={`${cases.length}${run.runs > 1 ? ` × ${run.runs} corridas` : ""}`} />
        <Stat label="Duración" value={formatDuration(run.durationMs)} />
        <Stat label="Tokens" value={`${tokens(run.inputTokens)} → ${tokens(run.outputTokens)}`} />
        <Stat label="Costo" value={usd(run.costUsd)} />
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="por-categoria">
        <h2 id="por-categoria" className="text-sm font-medium">
          Aciertos por categoría
        </h2>
        <div className="grid gap-x-8 gap-y-2.5 rounded-xl border p-4 sm:grid-cols-2" data-testid="eval-categories">
          {categories.map((c) => (
            <div key={c.category} className="flex flex-col gap-1">
              <span className="text-sm">{c.category}</span>
              <CategoryBar passed={c.passed} total={c.total} />
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="casos">
        <h2 id="casos" className="text-sm font-medium">
          Casos
        </h2>
        <ol className="flex flex-col overflow-hidden rounded-xl border">
          {cases.map((c) => (
            <li key={c.caseId} className="border-b last:border-b-0" data-testid="eval-case">
              <details className="group" open={c.outcome !== "pasa" || c.unstable}>
                <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                  <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full", c.outcome === "pasa" ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive")}>
                    {c.outcome === "pasa" ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
                  </span>
                  <span className="w-8 shrink-0 font-mono text-xs font-medium">{c.caseId}</span>
                  <span className="hidden w-44 shrink-0 truncate text-xs text-muted-foreground sm:block">{c.category}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{c.failures[0] ?? "pasó todas las reglas"}</span>
                  {run.runs > 1 && (
                    <Badge variant={c.unstable ? "outline" : "secondary"} className="shrink-0 tabular-nums">
                      {c.passes}/{c.runs}
                      {c.unstable && " · inestable"}
                    </Badge>
                  )}
                </summary>
                <div className="flex flex-col gap-4 border-t bg-muted/20 px-4 py-3 sm:pl-12">
                  {runsOf(c.caseId).map((r) => (
                    <div key={r.runNo} className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {run.runs > 1 && <span className="font-medium text-foreground">Corrida {r.runNo}</span>}
                        <span>{formatDuration(r.durationMs)}</span>
                        <span>
                          {tokens(r.inputTokens)} → {tokens(r.outputTokens)} tokens
                        </span>
                        <span>{usd(r.costUsd)}</span>
                        {r.traceId && (
                          <Link href={`/traces/${r.traceId}`} className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline">
                            <WaypointsIcon className="size-3.5" />
                            Ver traza
                          </Link>
                        )}
                      </div>
                      {r.error && <p className="font-mono text-xs text-destructive">{r.error}</p>}
                      <ul className="flex flex-col gap-1">
                        {r.results.map((check, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs">
                            {check.ok ? <CheckIcon className="mt-px size-3.5 shrink-0 text-primary" /> : <XIcon className="mt-px size-3.5 shrink-0 text-destructive" />}
                            <span className={check.ok ? "text-muted-foreground" : ""}>{check.detail}</span>
                          </li>
                        ))}
                      </ul>
                      {r.reply && <blockquote className="max-h-40 overflow-auto border-l-2 pl-3 text-xs whitespace-pre-wrap text-muted-foreground">{r.reply}</blockquote>}
                    </div>
                  ))}
                </div>
              </details>
            </li>
          ))}
        </ol>
      </section>
    </ObsMain>
  )
}
