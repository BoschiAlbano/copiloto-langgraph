"use client"

import * as React from "react"
import { CornerDownRightIcon, DatabaseIcon, GitBranchIcon, XIcon } from "lucide-react"
import type { BranchTree } from "@copilot/graph/branches"
import { branchBlocker, branchRows, type BranchRow, type PageStatus } from "@copilot/web/turn-view"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { fetchBranches } from "@/lib/api"
import { since } from "@/lib/format"
import { cn } from "@/lib/utils"

// Las versiones de la conversación (specs/ramas-del-hilo.md, R4 y R5). En pantallas anchas es una columna a la derecha
// del chat; en las angostas, una hoja lateral, como la memoria.

const TITLE = "Versiones de la conversación"
const DESCRIPTION = "Cada vez que editás un mensaje o reintentás una respuesta, nace una versión. Abrí cualquiera para seguir desde ahí."

/** ¿La pantalla es ancha (desde 1280 px)? Se lee del navegador; en el servidor, no. */
function useWide() {
  return React.useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(min-width: 1280px)")
      query.addEventListener("change", onChange)
      return () => query.removeEventListener("change", onChange)
    },
    () => window.matchMedia("(min-width: 1280px)").matches,
    () => false,
  )
}

interface PanelProps {
  threadId: string
  /** Cambia cada vez que el hilo puede haber cambiado (un turno, editar, reintentar, abrir una versión). */
  refreshKey: number
  status: PageStatus
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Abre esa versión; devuelve true si se abrió. */
  onOpenBranch: (tipId: string) => Promise<boolean>
}

export function BranchesPanel(props: PanelProps) {
  const wide = useWide()
  if (wide) {
    if (!props.open) return null
    return (
      <aside aria-label={TITLE} className="flex w-80 shrink-0 flex-col border-l bg-background">
        <div className="flex items-start gap-2 border-b px-4 py-3.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="text-sm font-medium">{TITLE}</h2>
            <p className="text-xs text-muted-foreground">{DESCRIPTION}</p>
          </div>
          <Button variant="ghost" size="icon-xs" aria-label="Cerrar las versiones" onClick={() => props.onOpenChange(false)}>
            <XIcon />
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <BranchList {...props} />
        </ScrollArea>
      </aside>
    )
  }
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>{TITLE}</SheetTitle>
          <SheetDescription>{DESCRIPTION}</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <BranchList {...props} onOpenBranch={async (tipId) => (await props.onOpenBranch(tipId)) && (props.onOpenChange(false), true)} />
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

/** La lista: se pide al abrir el panel y cada vez que el hilo cambia. */
function BranchList({ threadId, refreshKey, status, onOpenBranch }: PanelProps) {
  const [tree, setTree] = React.useState<BranchTree>()
  const [error, setError] = React.useState<string>()
  const [opening, setOpening] = React.useState<string>()
  // «hace 5 min» se calcula recién en el navegador (como en la barra de hilos).
  const [now, setNow] = React.useState<Date>()

  React.useEffect(() => {
    let alive = true
    fetchBranches(threadId)
      .then((t) => alive && (setTree(t), setError(undefined), setNow(new Date())))
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [threadId, refreshKey])

  if (error) {
    return (
      <Alert variant="destructive" className="m-4 w-auto">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }
  if (!tree) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }
  if (tree.branches.length <= 1) {
    return (
      <Empty className="mt-6 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranchIcon />
          </EmptyMedia>
          <EmptyTitle className="text-sm">Una sola versión</EmptyTitle>
          <EmptyDescription>Esta conversación tiene una sola versión. Editá un mensaje o reintentá una respuesta para crear otra.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const blocker = branchBlocker(status)
  async function open(tipId: string) {
    setOpening(tipId)
    try {
      await onOpenBranch(tipId)
    } finally {
      setOpening(undefined)
    }
  }
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="branches-panel">
      {blocker && <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{blocker}</p>}
      <ol className="flex flex-col gap-1.5">
        {branchRows(tree).map((row) => (
          <BranchItem
            key={row.branch.version}
            row={row}
            now={now}
            busy={opening === row.branch.tipId}
            disabled={Boolean(blocker) || Boolean(opening)}
            onOpen={() => open(row.branch.tipId)}
          />
        ))}
      </ol>
    </div>
  )
}

function BranchItem({ row, now, busy, disabled, onOpen }: { row: BranchRow; now?: Date; busy: boolean; disabled: boolean; onOpen: () => void }) {
  const { branch, depth } = row
  const openable = !branch.current && branch.complete && !disabled
  return (
    <li className="flex items-start gap-1" style={{ paddingLeft: `${Math.min(depth, 4) * 0.875}rem` }}>
      {depth > 0 && <CornerDownRightIcon aria-hidden className="mt-3 size-3.5 shrink-0 text-muted-foreground/70" />}
      <button
        type="button"
        data-testid={`branch-${branch.version}`}
        aria-current={branch.current ? "true" : undefined}
        aria-label={`Versión ${branch.version}: ${branch.label}${branch.current ? " (actual)" : ""}`}
        disabled={!openable}
        onClick={onOpen}
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          branch.current ? "border-border bg-muted/70" : "border-transparent",
          openable && "hover:border-border hover:bg-muted/40",
          !openable && !branch.current && "cursor-not-allowed opacity-60",
        )}
      >
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium">Versión {branch.version}</span>
          {branch.current && <Badge variant="secondary">Actual</Badge>}
          {!branch.complete && !branch.current && <Badge variant="outline">Incompleta</Badge>}
          {busy && <Spinner className="ml-auto size-3.5" />}
        </span>
        <span className="line-clamp-2 text-sm text-muted-foreground">{branch.label}</span>
        <span className="text-xs text-muted-foreground">
          {[`${branch.messageCount} ${branch.messageCount === 1 ? "mensaje" : "mensajes"}`, now && branch.updatedAt && since(branch.updatedAt, now)]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {branch.executedActions.length > 0 && (
          <span className="mt-0.5 flex items-start gap-1.5 text-xs text-foreground">
            <DatabaseIcon aria-hidden className="mt-px size-3.5 shrink-0" />
            Ejecutó una acción que no está en la versión actual
          </span>
        )}
      </button>
    </li>
  )
}
