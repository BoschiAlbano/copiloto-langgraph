"use client"

import * as React from "react"
import {
  AlertCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleCheckIcon,
  CircleXIcon,
  DatabaseIcon,
  FileBarChartIcon,
  GitBranchIcon,
  MessageSquareTextIcon,
  RotateCwIcon,
  UserCheckIcon,
} from "lucide-react"
import type { ChatItem, TurnPart } from "@copilot/web/turn-view"
import { AGENT_LABELS, INTENT_LABELS, SECTION_LABELS, describeRetryTarget, describeTool } from "@copilot/web/turn-view"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageContent, MessageHeader } from "@/components/ui/message"
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
import { Markdown } from "./markdown"
import { TurnSummary } from "./turn-summary"

type Turn = Extract<ChatItem, { kind: "turn" }>
type Activity = Extract<TurnPart, { type: "route" | "agent" | "tool" | "section" | "retry" | "text" }>

const isActivity = (p: TurnPart): p is Activity =>
  p.type === "route" || p.type === "agent" || p.type === "tool" || p.type === "section" || p.type === "retry" || (p.type === "text" && p.kind === "step")

/** Agrupa las partes: los pasos seguidos van en un mismo `Trace`; una respuesta, una acción o un aviso lo cortan. */
function groups(parts: TurnPart[]): ({ kind: "trace"; parts: Activity[] } | { kind: "part"; part: TurnPart })[] {
  const out: ({ kind: "trace"; parts: Activity[] } | { kind: "part"; part: TurnPart })[] = []
  for (const part of parts) {
    const last = out.at(-1)
    if (isActivity(part)) {
      if (last?.kind === "trace") last.parts.push(part)
      else out.push({ kind: "trace", parts: [part] })
    } else out.push({ kind: "part", part })
  }
  return out
}

function ActivityLine({ part, turnRunning }: { part: Activity; turnRunning: boolean }) {
  if (part.type === "route") {
    const steps = part.tasks.map((t) => INTENT_LABELS[t.intent]).join(" → ")
    return (
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <GitBranchIcon />
            </TraceIcon>
            <TraceTitle>Plan: {steps}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <ol className="flex list-decimal flex-col gap-1 pl-4">
            {part.tasks.map((t, i) => (
              <li key={i}>
                <span className="text-foreground">{INTENT_LABELS[t.intent]}</span>: {t.request}
              </li>
            ))}
          </ol>
          {part.reason && <p className="mt-2 text-xs">{part.reason}</p>}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    )
  }
  if (part.type === "agent") {
    const running = part.status === "running" && turnRunning
    return (
      <TraceLine status={running ? "running" : undefined}>
        <TraceIcon>
          <BotIcon />
        </TraceIcon>
        <TraceTitle>
          {running ? "Trabajando: " : ""}agente de {AGENT_LABELS[part.agent].toLowerCase()}
        </TraceTitle>
      </TraceLine>
    )
  }
  if (part.type === "tool") {
    const { title, detail } = describeTool(part.name, part.args)
    const status = part.status === "running" ? "running" : part.status === "error" ? "error" : undefined
    const retries = part.retry ? part.retry.attempt - 1 : 0
    const verb =
      part.status === "running"
        ? part.retry
          ? `Reintentando (${part.retry.attempt} de ${part.retry.attempts})`
          : "Consultando"
        : part.status === "error"
          ? "No se pudo consultar"
          : part.status === "skipped"
            ? "No se ejecutó (tope de consultas)"
            : "Consultó"
    return (
      <TraceLine status={status}>
        <TraceIcon>{part.status === "error" ? <CircleXIcon /> : part.retry ? <RotateCwIcon /> : <DatabaseIcon />}</TraceIcon>
        <TraceTitle>
          {verb}: {title}
        </TraceTitle>
        {part.status !== "running" && retries > 0 && (
          <TraceDescription>
            {part.status === "error" ? `tras ${retries} ${retries === 1 ? "reintento" : "reintentos"}` : `al ${retries + 1}.º intento`}
          </TraceDescription>
        )}
        {detail && <TraceDescription className="hidden min-w-0 truncate sm:block">{detail}</TraceDescription>}
      </TraceLine>
    )
  }
  if (part.type === "retry") {
    const running = turnRunning
    return (
      <TraceLine status={running ? "running" : undefined}>
        <TraceIcon>
          <RotateCwIcon />
        </TraceIcon>
        <TraceTitle>
          {running ? "Reintentando" : "Se reintentó"} {describeRetryTarget(part.target)} ({part.attempt} de {part.attempts})
        </TraceTitle>
      </TraceLine>
    )
  }
  if (part.type === "section") {
    return (
      <TraceLine status={part.status === "error" ? "error" : undefined}>
        <TraceIcon>{part.status === "error" ? <CircleXIcon /> : <FileBarChartIcon />}</TraceIcon>
        <TraceTitle>
          Sección {SECTION_LABELS[part.section].toLowerCase()}: {part.status === "ok" ? "lista" : "falló"}
        </TraceTitle>
      </TraceLine>
    )
  }
  return (
    <TraceLine status={part.streaming ? "running" : undefined}>
      <TraceIcon>
        <MessageSquareTextIcon />
      </TraceIcon>
      <TraceTitle className="whitespace-normal">{part.text}</TraceTitle>
    </TraceLine>
  )
}

export function CopilotText({ text, author, streaming }: { text: string; author?: string; streaming?: boolean }) {
  return (
    <Message align="start">
      <MessageContent>
        {author && <MessageHeader>{author}</MessageHeader>}
        <Bubble variant="ghost">
          <BubbleContent className="text-[0.95rem]" data-testid="copilot-text" data-streaming={streaming || undefined}>
            <Markdown text={text} />
            {streaming && <span aria-hidden className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-foreground/60" />}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}

function Part({ part }: { part: TurnPart }) {
  if (part.type === "text") {
    if (part.kind === "notice") {
      return (
        <Marker>
          <MarkerIcon>
            <AlertCircleIcon />
          </MarkerIcon>
          <MarkerContent>{part.text}</MarkerContent>
        </Marker>
      )
    }
    const author = part.author === "supervisor" ? undefined : AGENT_LABELS[part.author]
    return <CopilotText text={part.text} author={author} streaming={part.streaming} />
  }
  if (part.type === "action") {
    return (
      <Alert variant={part.ok ? "default" : "destructive"}>
        {part.ok ? <CheckCircle2Icon /> : <CircleXIcon />}
        <AlertTitle>{part.ok ? "Resultado de la acción" : "La acción no se pudo hacer"}</AlertTitle>
        <AlertDescription>{part.message}</AlertDescription>
      </Alert>
    )
  }
  if (part.type === "decision") {
    return (
      <Marker variant="separator">
        <MarkerIcon>
          <UserCheckIcon />
        </MarkerIcon>
        <MarkerContent>{part.text}</MarkerContent>
      </Marker>
    )
  }
  return null
}

export function TurnView({ turn, sessionCost }: { turn: Turn; sessionCost: string }) {
  const parts = groups(turn.parts)
  return (
    <div className="flex flex-col gap-4">
      {parts.map((g, i) =>
        g.kind === "trace" ? (
          <Trace key={i}>
            {g.parts.map((p, j) => (
              <ActivityLine key={j} part={p} turnRunning={turn.running} />
            ))}
          </Trace>
        ) : (
          <Part key={i} part={g.part} />
        ),
      )}
      {turn.running && turn.parts.length === 0 && (
        <Trace>
          <TraceLine status="running">
            <TraceIcon>
              <CircleCheckIcon />
            </TraceIcon>
            <TraceTitle>Leyendo tu pedido</TraceTitle>
          </TraceLine>
        </Trace>
      )}
      {turn.error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>El turno no terminó</AlertTitle>
          <AlertDescription>{turn.error}</AlertDescription>
        </Alert>
      )}
      {turn.result && <TurnSummary result={turn.result} sessionCost={sessionCost} />}
    </div>
  )
}
