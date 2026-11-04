"use client"

import * as React from "react"
import { ArrowUpIcon } from "lucide-react"
import type { PageStatus } from "@copilot/web/turn-view"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"

const MAX_CHARS = 4000

const PLACEHOLDER: Record<PageStatus, string> = {
  ready: "Preguntá por turnos, ventas o stock, pedí una acción o un reporte…",
  running: "El copiloto está respondiendo…",
  awaiting: "Primero decidí sobre la acción de arriba.",
  pending: "El turno anterior quedó a medias: continualo antes de escribir.",
}

/** La entrada del chat. Solo se puede escribir con el hilo listo (R9): no con una tarjeta ni con un turno a medias. */
export function Composer({ status, onSend }: { status: PageStatus; onSend: (text: string) => void }) {
  const [text, setText] = React.useState("")
  const disabled = status !== "ready"
  const trimmed = text.trim()
  const canSend = !disabled && trimmed.length > 0 && text.length <= MAX_CHARS

  function submit(event?: React.FormEvent) {
    event?.preventDefault()
    if (!canSend) return
    onSend(trimmed)
    setText("")
  }

  return (
    <form onSubmit={submit} className="w-full">
      <InputGroup className="rounded-2xl bg-background shadow-sm">
        <InputGroupTextarea
          aria-label="Mensaje para el copiloto"
          value={text}
          disabled={disabled}
          placeholder={PLACEHOLDER[status]}
          rows={1}
          className="max-h-48 min-h-12 px-4 pt-3.5 text-[0.95rem]"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter manda; Shift+Enter hace un salto de línea.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e)
          }}
        />
        <InputGroupAddon align="block-end" className="px-3 pb-3">
          <InputGroupText className="text-xs text-muted-foreground">
            {text.length > MAX_CHARS * 0.8 ? `${text.length} / ${MAX_CHARS}` : "Enter para mandar · Shift+Enter, salto de línea"}
          </InputGroupText>
          <InputGroupButton type="submit" variant="default" size="icon-sm" className="ml-auto rounded-full" disabled={!canSend} aria-label="Mandar">
            {status === "running" ? <Spinner /> : <ArrowUpIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}
