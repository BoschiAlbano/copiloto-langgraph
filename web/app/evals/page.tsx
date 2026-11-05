import Link from "next/link"
import { FlaskConicalIcon, GitCompareArrowsIcon } from "lucide-react"
import type { EvalListView, EvalRunSummary } from "@copilot/web/handlers"
import { percent } from "@copilot/observability/eval-report"
import { formatDuration } from "@copilot/web/trace-view"
import { ObsMain, ObsTitle } from "@/components/observability/obs-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getHandlers } from "@/lib/agent"
import { usd } from "@/lib/format"
import { when } from "@/lib/observability"

export const dynamic = "force-dynamic"

/** El nombre corto de una corrida, para elegirla en el formulario. */
const runName = (r: EvalRunSummary) => `${when(r.startedAt)} · ${r.label ?? r.prompts} · ${r.passed}/${r.total}`

const SELECT =
  "h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"

// Las corridas del set de evaluación (fase 11, R14). Se lanzan desde la terminal (`npm run eval`).
export default async function EvalsPage() {
  const response = await getHandlers().listEvals()
  const body = (await response.json()) as EvalListView | { error: string }
  const runs = "error" in body ? [] : body.runs

  return (
    <ObsMain>
      <ObsTitle
        title="Evaluaciones"
        description={
          <>
            Cada corrida pasa las conversaciones del set por el copiloto real y comprueba el resultado con reglas. Se lanzan desde la terminal con{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">npm run eval</code>.
          </>
        }
      />

      {"error" in body ? (
        <Alert variant="destructive">
          <AlertDescription>{body.error}</AlertDescription>
        </Alert>
      ) : runs.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FlaskConicalIcon />
            </EmptyMedia>
            <EmptyTitle>Todavía no hay corridas</EmptyTitle>
            <EmptyDescription>
              Corré <code className="font-mono">npm run eval</code> en la terminal y aparece acá.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {runs.length >= 2 && (
            <form action="/evals/compare" method="get" className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-end" aria-label="Comparar dos corridas">
              <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs text-muted-foreground">
                Antes (A)
                <select name="a" defaultValue={runs[1]!.id} className={SELECT}>
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {runName(r)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs text-muted-foreground">
                Después (B)
                <select name="b" defaultValue={runs[0]!.id} className={SELECT}>
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {runName(r)}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={buttonVariants({ className: "gap-1.5" })}>
                <GitCompareArrowsIcon />
                Comparar
              </button>
            </form>
          )}

          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">Cuándo</TableHead>
                  <TableHead>Corrida</TableHead>
                  <TableHead className="hidden md:table-cell">Modelo del agente</TableHead>
                  <TableHead className="text-right">Aciertos</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Costo</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Duración</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id} data-testid="eval-run-row">
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{when(r.startedAt)}</TableCell>
                    <TableCell className="max-w-0 w-full">
                      <Link href={`/evals/${r.id}`} className="block truncate font-medium hover:underline">
                        {r.label ?? "Sin nombre"}
                      </Link>
                      <span className="block truncate text-xs text-muted-foreground">
                        prompts {r.prompts}
                        {r.runs > 1 && ` · ${r.runs} corridas`}
                      </span>
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{r.models.agent}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={r.passed === r.total ? "secondary" : "outline"} className="tabular-nums">
                        {r.passed}/{r.total} · {percent(r.passed, r.total)}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden text-right text-xs tabular-nums sm:table-cell">{usd(r.costUsd)}</TableCell>
                    <TableCell className="hidden text-right text-xs tabular-nums lg:table-cell">{formatDuration(r.durationMs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </ObsMain>
  )
}
