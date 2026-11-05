"use client"

import * as React from "react"
import { GitBranchIcon, PlayIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import type { ThreadSummary } from "@copilot/graph/threads"
import type { ThreadView } from "@copilot/web/handlers"
import { retryTargets, type PageStatus } from "@copilot/web/turn-view"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { ThemeToggle } from "@/components/theme-toggle"
import { useChat } from "@/hooks/use-chat"
import { fetchThreads } from "@/lib/api"
import { costOf, usd } from "@/lib/format"
import { AppSidebar } from "./app-sidebar"
import { ApprovalCard } from "./approval-card"
import { BranchesPanel } from "./branches-panel"
import { Composer } from "./composer"
import { HumanMessage } from "./human-message"
import { MemorySheet } from "./memory-sheet"
import { CopilotText, RetryButton, TurnView } from "./turn"

const STATUS: Record<PageStatus, { label: string; variant: "secondary" | "outline" | "destructive" | "default" }> = {
  ready: { label: "Listo", variant: "secondary" },
  running: { label: "Respondiendo", variant: "default" },
  awaiting: { label: "Espera tu decisión", variant: "outline" },
  pending: { label: "Turno a medias", variant: "destructive" },
}

const SUGGESTIONS = ["¿Cuántos turnos hay mañana?", "¿Cuánto stock queda de cera mate?", "Armame el resumen de la semana."]

export function ChatApp({ initial, initialThreads }: { initial: ThreadView; initialThreads: ThreadSummary[] }) {
  const [threads, setThreads] = React.useState(initialThreads)
  const [memoryOpen, setMemoryOpen] = React.useState(false)
  const [branchesOpen, setBranchesOpen] = React.useState(false)
  // Cada turno, edición, reintento o cambio de versión puede cambiar las versiones: el panel las vuelve a pedir.
  const [branchesKey, setBranchesKey] = React.useState(0)
  const afterTurn = React.useCallback(() => {
    fetchThreads().then(setThreads).catch(() => undefined)
    setBranchesKey((k) => k + 1)
  }, [])
  const { state, send, decide, resume, edit, retry, openBranch, dismissNotice } = useChat(initial, { onTurnEnd: afterTurn })
  const sessionCost = usd(costOf(state.session))
  const status = STATUS[state.status]
  const first = state.items.find((i) => i.kind === "human")
  const title = first?.kind === "human" ? first.text : "Conversación nueva"
  // Editar y reintentar (fase 10): solo con el hilo listo, igual que un mensaje nuevo.
  const canBranch = state.status === "ready"
  const retries = retryTargets(state.items)

  return (
    <SidebarProvider>
      <AppSidebar threads={threads} currentId={state.threadId} onOpenMemory={() => setMemoryOpen(true)} />
      <SidebarInset className="h-svh min-h-0">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mr-1 data-vertical:h-4" />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="truncate text-sm font-medium">{title}</h1>
            <span className="hidden shrink-0 font-mono text-xs text-muted-foreground md:inline">{state.threadId}</span>
            <Badge variant={status.variant} className="shrink-0">
              {state.status === "running" && <Spinner data-icon="inline-start" />}
              {status.label}
            </Badge>
          </div>
          <span className="hidden text-xs text-muted-foreground sm:inline">Sesión: {sessionCost}</span>
          <Button
            variant={branchesOpen ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={branchesOpen}
            aria-label="Versiones de la conversación"
            onClick={() => setBranchesOpen((open) => !open)}
          >
            <GitBranchIcon data-icon="inline-start" />
            <span className="hidden sm:inline">Versiones</span>
          </Button>
          <ThemeToggle />
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <MessageScrollerProvider autoScroll>
              <MessageScroller className="flex-1">
                <MessageScrollerViewport>
                  <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-8 px-4 py-8">
                    {state.items.length === 0 && (
                      <MessageScrollerItem messageId="vacio">
                        <Empty className="mt-[12vh]">
                          <EmptyHeader>
                            <EmptyTitle className="text-xl">¿En qué te ayudo hoy?</EmptyTitle>
                            <EmptyDescription>
                              Consultá turnos, ventas y stock, pedí un reporte, o pedile que agende, venda o ajuste algo. Ninguna acción se hace sin tu aprobación.
                            </EmptyDescription>
                          </EmptyHeader>
                          <EmptyContent className="flex-row flex-wrap justify-center gap-2">
                            {SUGGESTIONS.map((s) => (
                              <Button key={s} variant="outline" size="sm" className="rounded-full" onClick={() => send(s)}>
                                {s}
                              </Button>
                            ))}
                          </EmptyContent>
                        </Empty>
                      </MessageScrollerItem>
                    )}
                    {state.items.map((item, index) => {
                      const target = canBranch ? retries.get(index) : undefined
                      const onRetry = target ? () => retry(target) : undefined
                      return (
                        <MessageScrollerItem key={item.id} messageId={item.id} scrollAnchor={item.kind === "human"}>
                          {item.kind === "human" ? (
                            <HumanMessage item={item} canEdit={canBranch} onEdit={edit} />
                          ) : item.kind === "history" ? (
                            <div className="flex flex-col gap-2">
                              {item.step ? <p className="pl-1 text-sm text-muted-foreground">{item.text}</p> : <CopilotText text={item.text} />}
                              {onRetry && <RetryButton onRetry={onRetry} />}
                            </div>
                          ) : (
                            <TurnView turn={item} sessionCost={sessionCost} onRetry={onRetry} />
                          )}
                        </MessageScrollerItem>
                      )
                    })}
                    {state.awaiting && (
                      <MessageScrollerItem messageId={`card-${state.awaiting.action.id}`}>
                        <ApprovalCard request={state.awaiting} busy={state.status === "running"} onDecide={decide} />
                      </MessageScrollerItem>
                    )}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>

            <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-3 px-4 pt-2 pb-4">
              {state.notice && (
                <Alert>
                  <TriangleAlertIcon />
                  <AlertDescription>{state.notice}</AlertDescription>
                  <AlertAction>
                    <Button variant="ghost" size="icon-xs" aria-label="Cerrar aviso" onClick={dismissNotice}>
                      <XIcon />
                    </Button>
                  </AlertAction>
                </Alert>
              )}
              {state.status === "pending" && (
                <Alert variant="destructive">
                  <TriangleAlertIcon />
                  <AlertTitle>El último turno quedó a medias</AlertTitle>
                  <AlertDescription>Se cortó antes de terminar. Continualo desde donde quedó: no se repite nada de lo que ya se hizo.</AlertDescription>
                  <AlertAction>
                    <Button size="sm" onClick={resume}>
                      <PlayIcon data-icon="inline-start" />
                      Continuar
                    </Button>
                  </AlertAction>
                </Alert>
              )}
              <Composer status={state.status} onSend={send} />
            </div>
          </div>
          <BranchesPanel
            threadId={state.threadId}
            refreshKey={branchesKey}
            status={state.status}
            open={branchesOpen}
            onOpenChange={setBranchesOpen}
            onOpenBranch={openBranch}
          />
        </div>
      </SidebarInset>
      <MemorySheet open={memoryOpen} onOpenChange={setMemoryOpen} />
    </SidebarProvider>
  )
}
