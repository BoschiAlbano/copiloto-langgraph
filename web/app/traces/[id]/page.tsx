import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon, CircleAlertIcon, MessageCircleIcon } from "lucide-react"
import type { Trace } from "@copilot/web/handlers"
import { INTENT_LABELS } from "@copilot/web/turn-view"
import { formatDuration, TURN_KIND_LABELS } from "@copilot/web/trace-view"
import { ObsMain } from "@/components/observability/obs-header"
import { TraceTimeline } from "@/components/observability/trace-timeline"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { getHandlers } from "@/lib/agent"
import { tokens, usd } from "@/lib/format"
import { statusBadge, when } from "@/lib/observability"
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

// Una traza (fase 11, R5): el resumen del turno y su línea de tiempo.
export default async function TracePage({ params }: PageProps<"/traces/[id]">) {
  const { id } = await params
  const response = await getHandlers().getTrace(id)
  if (response.status === 400 || response.status === 404) notFound()
  if (!response.ok) throw new Error("No se pudo leer la traza.")
  const trace = (await response.json()) as Trace
  const status = statusBadge(trace.status)
  const route = trace.route.map((i) => INTENT_LABELS[i as keyof typeof INTENT_LABELS] ?? i).join(" → ")

  return (
    <ObsMain>
      <div className="flex flex-col gap-3">
        <Link href="/traces" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2 w-fit gap-1.5 text-muted-foreground")}>
          <ArrowLeftIcon />
          Todas las trazas
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={status.variant}>{status.label}</Badge>
          <Badge variant="outline">{TURN_KIND_LABELS[trace.kind]}</Badge>
          {route && <Badge variant="outline">{route}</Badge>}
          <span className="text-xs text-muted-foreground">{when(trace.startedAt)}</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight break-words">{trace.input || TURN_KIND_LABELS[trace.kind]}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{trace.threadId}</span>
          {trace.evalRunId ? (
            <Link href={`/evals/${trace.evalRunId}`} className="underline-offset-4 hover:underline">
              Caso {trace.evalCaseId} de una corrida de evaluación
            </Link>
          ) : (
            <Link href={`/threads/${trace.threadId}`} className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
              <MessageCircleIcon className="size-3.5" />
              Abrir el hilo
            </Link>
          )}
          <Link href={`/traces?thread=${trace.threadId}`} className="underline-offset-4 hover:underline">
            Otras trazas de este hilo
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Duración" value={formatDuration(trace.durationMs)} />
        <Stat label="Llamadas al modelo" value={trace.calls} />
        <Stat label="Tokens" value={`${tokens(trace.inputTokens)} → ${tokens(trace.outputTokens)}`} />
        <Stat label="Costo" value={usd(trace.costUsd)} />
        <Stat label="Reintentos" value={trace.retries} />
      </div>

      {trace.error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>El turno terminó con un error</AlertTitle>
          <AlertDescription className="font-mono text-xs break-words">{trace.error}</AlertDescription>
        </Alert>
      )}

      <TraceTimeline trace={trace} />
    </ObsMain>
  )
}
