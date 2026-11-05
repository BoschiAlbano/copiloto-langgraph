import Link from "next/link"
import { RotateCwIcon, WaypointsIcon, XIcon } from "lucide-react"
import type { TraceListView } from "@copilot/web/handlers"
import { INTENT_LABELS } from "@copilot/web/turn-view"
import { formatDuration, TURN_KIND_LABELS } from "@copilot/web/trace-view"
import { ObsMain, ObsTitle } from "@/components/observability/obs-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getHandlers } from "@/lib/agent"
import { tokens, usd } from "@/lib/format"
import { statusBadge, when } from "@/lib/observability"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

// La lista de trazas (fase 11, R5): las recientes, por hilo y con errores.
export default async function TracesPage({ searchParams }: PageProps<"/traces">) {
  const params = await searchParams
  const thread = typeof params.thread === "string" ? params.thread : undefined
  const errors = params.errors === "1"
  const url = new URL("http://local/api/traces")
  if (thread) url.searchParams.set("thread", thread)
  if (errors) url.searchParams.set("errors", "1")
  const response = await getHandlers().listTraces(url)
  const body = (await response.json()) as TraceListView | { error: string }
  const link = (next: { thread?: string; errors?: boolean }) => {
    const q = new URLSearchParams()
    if (next.thread) q.set("thread", next.thread)
    if (next.errors) q.set("errors", "1")
    return `/traces${q.size ? `?${q}` : ""}`
  }
  const filter = (href: string, active: boolean, label: string) => (
    <Link href={href} aria-current={active ? "true" : undefined} className={buttonVariants({ variant: active ? "secondary" : "outline", size: "sm" })}>
      {label}
    </Link>
  )

  return (
    <ObsMain>
      <ObsTitle title="Trazas" description="Lo que pasó adentro de cada turno: los nodos, las llamadas al modelo, las herramientas, los reintentos y los errores. Se guardan 30 días.">
        <div className="flex flex-wrap items-center gap-2">
          {thread && (
            <Link href={link({ errors })} className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "max-w-full gap-1.5 font-mono text-xs")}>
              <span className="truncate">{thread}</span>
              <XIcon aria-label="Quitar el filtro del hilo" />
            </Link>
          )}
          {filter(link({ thread }), !errors, "Todas")}
          {filter(link({ thread, errors: true }), errors, "Con errores")}
        </div>
      </ObsTitle>

      {"error" in body ? (
        <Alert variant="destructive">
          <AlertDescription>{body.error}</AlertDescription>
        </Alert>
      ) : body.traces.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WaypointsIcon />
            </EmptyMedia>
            <EmptyTitle>Todavía no hay trazas{errors ? " con errores" : ""}</EmptyTitle>
            <EmptyDescription>Cada turno del chat deja la suya. Mandá un mensaje y volvé.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36">Cuándo</TableHead>
                <TableHead>Mensaje</TableHead>
                <TableHead className="hidden md:table-cell">Ruta</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Duración</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Tokens</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Costo</TableHead>
                <TableHead className="text-right">Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {body.traces.map((t) => {
                const status = statusBadge(t.status)
                return (
                  <TableRow key={t.id} data-testid="trace-row">
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{when(t.startedAt)}</TableCell>
                    <TableCell className="max-w-0 w-full">
                      <Link href={`/traces/${t.id}`} className="block truncate font-medium hover:underline">
                        {t.input || TURN_KIND_LABELS[t.kind]}
                      </Link>
                      <span className="block truncate text-xs text-muted-foreground">
                        {TURN_KIND_LABELS[t.kind]} · <span className="font-mono">{t.threadId}</span>
                        {t.evalCaseId && ` · caso ${t.evalCaseId}`}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                      {t.route.map((i) => INTENT_LABELS[i as keyof typeof INTENT_LABELS] ?? i).join(" → ") || "—"}
                    </TableCell>
                    <TableCell className="hidden text-right text-xs tabular-nums sm:table-cell">{formatDuration(t.durationMs)}</TableCell>
                    <TableCell className="hidden text-right text-xs tabular-nums lg:table-cell">
                      {tokens(t.inputTokens)} → {tokens(t.outputTokens)}
                    </TableCell>
                    <TableCell className="hidden text-right text-xs tabular-nums lg:table-cell">{usd(t.costUsd)}</TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center justify-end gap-1.5">
                        {t.retries > 0 && (
                          <Badge variant="outline" title={`${t.retries} reintentos`}>
                            <RotateCwIcon data-icon="inline-start" />
                            {t.retries}
                          </Badge>
                        )}
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </span>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </ObsMain>
  )
}
