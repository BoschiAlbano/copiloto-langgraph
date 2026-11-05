"use client"

import { BrainIcon, ReceiptIcon } from "lucide-react"
import type { TurnResult } from "@copilot/graph/run-turn"
import { AGENT_LABELS, SECTION_LABELS, describeTool } from "@copilot/web/turn-view"
import { Badge } from "@/components/ui/badge"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"
import { costOf, tokens, totals, usd } from "@/lib/format"

/** El resumen del turno (R7): lo mismo que la terminal, en una línea que se despliega. */
export function TurnSummary({ result, sessionCost }: { result: TurnResult; sessionCost: string }) {
  const t = totals(result.summary.usage)
  const sections = result.report ? Object.entries(result.report.sections) : []
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon>
            <ReceiptIcon />
          </TraceIcon>
          <TraceTitle className="shrink-0">{usd(costOf(result.summary.usage))}</TraceTitle>
          <TraceDescription className="min-w-0 truncate">
            {t.calls} {t.calls === 1 ? "llamada" : "llamadas"} · {tokens(t.input)} → {tokens(t.output)} tokens · sesión {sessionCost}
          </TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>
          {result.agents.map((a, i) => {
            const at = totals(a.usage)
            return (
              <TraceLine key={i}>
                <TraceIcon>
                  <BrainIcon />
                </TraceIcon>
                <TraceTitle>
                  Agente de {AGENT_LABELS[a.agent].toLowerCase()}
                  {a.tools.length > 0 && `: ${a.tools.map((name) => describeTool(name, {}).title).join(", ")}`}
                  {a.waiting && " (esperando tu decisión)"}
                </TraceTitle>
                <TraceDescription>
                  {usd(costOf(a.usage))} · {at.calls} {at.calls === 1 ? "llamada" : "llamadas"}
                </TraceDescription>
              </TraceLine>
            )
          })}
          {result.coordination.length > 0 && (
            <TraceLine>
              <TraceIcon>
                <BrainIcon />
              </TraceIcon>
              <TraceTitle>Coordinación (router)</TraceTitle>
              <TraceDescription>{usd(costOf(result.coordination))}</TraceDescription>
            </TraceLine>
          )}
          {result.summary.usage.map((u) => (
            <TraceLine key={u.model}>
              <TraceIcon>
                <ReceiptIcon />
              </TraceIcon>
              <TraceTitle>{u.model}</TraceTitle>
              <TraceDescription>
                {u.calls} · {tokens(u.inputTokens)} → {tokens(u.outputTokens)} tokens · {usd(costOf([u]))}
              </TraceDescription>
            </TraceLine>
          ))}
        </Trace>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge variant="secondary">{result.memoryCount === 1 ? "1 memoria en contexto" : `${result.memoryCount} memorias en contexto`}</Badge>
          {[...new Set(result.summary.failedTools ?? [])].map((name) => (
            <Badge key={name} variant="destructive">
              No se pudo consultar: {describeTool(name, {}).title.toLowerCase()}
            </Badge>
          ))}
          {sections.map(([section, status]) => (
            <Badge key={section} variant={status === "ok" ? "outline" : "destructive"}>
              {SECTION_LABELS[section as keyof typeof SECTION_LABELS]}: {status === "ok" ? "ok" : status === "error" ? "falló" : "falta"}
            </Badge>
          ))}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}
