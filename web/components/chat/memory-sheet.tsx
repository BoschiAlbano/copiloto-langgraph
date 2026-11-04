"use client"

import * as React from "react"
import { BookmarkIcon, Trash2Icon } from "lucide-react"
import type { Memory } from "@copilot/memory/store"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { fetchMemories, removeMemory } from "@/lib/api"
import { since } from "@/lib/format"

/**
 * Las memorias del negocio (R14): se listan y se borran de a una. Anotar es por el chat, donde el código valida qué se
 * guarda (fase 8).
 */
export function MemorySheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [memories, setMemories] = React.useState<Memory[]>()
  const [error, setError] = React.useState<string>()

  const load = React.useCallback(() => {
    setError(undefined)
    fetchMemories()
      .then(setMemories)
      .catch((e: Error) => setError(e.message))
  }, [])

  React.useEffect(() => {
    if (open) load()
  }, [open, load])

  async function remove(id: string) {
    try {
      await removeMemory(id)
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Memoria del negocio</SheetTitle>
          <SheetDescription>
            Reglas y preferencias que el copiloto tiene en cuenta en todas las conversaciones. Para anotar una, pedíselo en el chat («acordate de que…»).
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {!memories && !error && [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
          {memories?.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BookmarkIcon />
                </EmptyMedia>
                <EmptyTitle>No hay memorias</EmptyTitle>
                <EmptyDescription>Probá en el chat: «acordate de que los lunes no se agendan turnos».</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {memories?.map((m) => (
            <div key={m.id} className="flex items-start gap-3 rounded-xl border bg-card p-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <p className="text-sm leading-relaxed">{m.text}</p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={m.kind === "rule" ? "secondary" : "outline"}>{m.kind === "rule" ? "Regla" : "Preferencia"}</Badge>
                  <span>{since(m.createdAt)}</span>
                  <span className="font-mono">#{m.id}</span>
                </div>
              </div>
              <AlertDialog>
                <AlertDialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Borrar «${m.text}»`} />}>
                  <Trash2Icon />
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>¿Borrar esta memoria?</AlertDialogTitle>
                    <AlertDialogDescription>«{m.text}» deja de valer en todas las conversaciones. No se puede deshacer.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => remove(m.id)}>
                      Borrar
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
