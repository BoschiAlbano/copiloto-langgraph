"use client"

import * as React from "react"
import { BotIcon, BoxIcon, CircleAlertIcon, PauseIcon, RotateCwIcon, SparklesIcon, WrenchIcon } from "lucide-react"
import type { SpanKind, Trace, TraceSpan } from "@copilot/observability/trace-recorder"
import { formatDuration, prettyJson, SPAN_KIND_LABELS, SPAN_STATUS_LABELS, timelineRows } from "@copilot/web/trace-view"
import { AGENT_LABELS, TOOL_LABELS } from "@copilot/web/turn-view"
import { Badge } from "@/components/ui/badge"
import { tokens, usd } from "@/lib/format"
import { cn } from "@/lib/utils"

const KIND_ICON: Record<SpanKind, React.ReactNode> = {
  turn: <BoxIcon />,
  node: <BotIcon />,
  llm: <SparklesIcon />,
  tool: <WrenchIcon />,
}

/** El nombre de un paso como se lee: el del código y, si lo tiene, el de la pantalla («query_graph · Consultas»). */
function friendly(span: TraceSpan): string | undefined {
  if (span.kind === "node") return AGENT_LABELS[span.name as keyof typeof AGENT_LABELS]
  if (span.kind === "tool") return TOOL_LABELS[span.name]
  return undefined
}

const barColor = (span: TraceSpan) =>
  span.status === "error"
    ? "bg-destructive"
    : span.kind === "llm"
      ? "bg-primary"
      : span.kind === "tool"
        ? "bg-primary/55"
        : span.kind === "turn"
          ? "bg-muted-foreground/35"
          : "bg-muted-foreground/60"

/** La línea de tiempo de una traza (R5): cada paso, una barra; al tocar uno, su detalle. */
export function TraceTimeline({ trace }: { trace: Trace }) {
  const rows = React.useMemo(() => timelineRows(trace), [trace])
  const firstError = rows.find((r) => r.span.status === "error")
  const [selected, setSelected] = React.useState<string | undefined>(firstError?.span.id ?? rows[0]?.span.id)
  const span = rows.find((r) => r.span.id === selected)?.span

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="overflow-hidden rounded-xl border" data-testid="trace-timeline">
        <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span>Paso</span>
          <span className="tabular-nums">0 — {formatDuration(trace.durationMs)}</span>
        </div>
        <ol>
          {rows.map(({ span: s, depth, offsetPct, widthPct, detail }) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelected(s.id)}
                aria-current={s.id === selected ? "true" : undefined}
                data-testid={`span-${s.kind}`}
                className={cn(
                  "grid w-full grid-cols-[minmax(0,13rem)_minmax(0,1fr)] items-center gap-3 border-b px-3 py-1.5 text-left text-xs transition-colors last:border-b-0 hover:bg-muted/40 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]",
                  s.id === selected && "bg-muted/70 hover:bg-muted/70",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${Math.min(depth, 6) * 0.75}rem` }}>
                  <span className={cn("shrink-0 text-muted-foreground [&_svg]:size-3.5", s.status === "error" && "text-destructive")}>
                    {s.status === "error" ? <CircleAlertIcon /> : s.status === "interrupted" ? <PauseIcon /> : KIND_ICON[s.kind]}
                  </span>
                  <span className="truncate font-medium">{s.name}</span>
                  {s.retries ? <RotateCwIcon aria-label={`${s.retries} reintentos`} className="size-3 shrink-0 text-muted-foreground" /> : null}
                </span>
                <span className="relative flex h-5 items-center">
                  <span
                    aria-hidden
                    className={cn("absolute h-2.5 rounded-full", barColor(s))}
                    style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
                  />
                  <span
                    className="absolute text-[0.7rem] whitespace-nowrap text-muted-foreground tabular-nums"
                    style={offsetPct + widthPct > 70 ? { right: `${100 - offsetPct}%`, paddingRight: "0.375rem" } : { left: `${offsetPct + widthPct}%`, paddingLeft: "0.375rem" }}
                  >
                    {formatDuration(s.duration)}
                    {detail && <span className="hidden md:inline"> · {detail}</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      {span && <SpanDetail span={span} />}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

function Code({ children }: { children: string }) {
  return <pre className="max-h-72 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{children}</pre>
}

function SpanDetail({ span }: { span: TraceSpan }) {
  const name = friendly(span)
  return (
    <aside className="flex h-fit flex-col gap-4 rounded-xl border p-4 lg:sticky lg:top-20" aria-label="Detalle del paso" data-testid="span-detail">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{SPAN_KIND_LABELS[span.kind]}</Badge>
          <Badge variant={span.status === "error" ? "destructive" : "secondary"}>{SPAN_STATUS_LABELS[span.status]}</Badge>
        </div>
        <h2 className="text-base font-semibold break-words">{span.name}</h2>
        {name && <p className="text-sm text-muted-foreground">{name}</p>}
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <Field label="Empezó">a los {formatDuration(span.start)}</Field>
        <Field label="Duró">{formatDuration(span.duration)}</Field>
        {span.kind === "llm" && (
          <>
            <Field label="Modelo">{span.model ?? "—"}</Field>
            <Field label="Costo">{usd(span.costUsd ?? null)}</Field>
            <Field label="Tokens de entrada">{tokens(span.inputTokens ?? 0)}</Field>
            <Field label="Tokens de salida">{tokens(span.outputTokens ?? 0)}</Field>
          </>
        )}
        {span.retries ? <Field label="Reintentos">{span.retries}</Field> : null}
      </dl>
      {span.error && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-destructive">Error</h3>
          <Code>{span.error}</Code>
        </div>
      )}
      {span.kind === "tool" && span.args !== undefined && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Argumentos</h3>
          <Code>{prettyJson(span.args)}</Code>
        </div>
      )}
      {span.kind === "tool" && span.result && !span.error && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Resultado (recortado a 2.000 caracteres)</h3>
          <Code>{prettyJson(span.result)}</Code>
        </div>
      )}
    </aside>
  )
}
