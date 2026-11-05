"use client"

import * as React from "react"
import { HistoryIcon, PencilIcon } from "lucide-react"
import type { Branch, ChatItem } from "@copilot/web/turn-view"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from "@/components/ui/input-group"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import { MAX_CHARS } from "./composer"

type Human = Extract<ChatItem, { kind: "human" }>

/** La marca de un mensaje que reemplazó a otro (R10, R13): la versión anterior quedó en la historia del hilo. */
function BranchMarker({ branch }: { branch: Branch }) {
  const what =
    branch.kind === "edit"
      ? "Editaste este mensaje; la versión anterior quedó en la historia del hilo."
      : "Reintentaste este turno; la respuesta anterior quedó en la historia del hilo."
  return (
    <Marker className="w-auto max-w-full justify-end text-xs" data-testid="branch-marker">
      <MarkerIcon>
        <HistoryIcon />
      </MarkerIcon>
      <MarkerContent>
        {what}
        {branch.replacedActions.length > 0 && (
          <span className="mt-1 block text-foreground">
            Lo que ya se había hecho no se deshace: {branch.replacedActions.map((a) => `«${a}»`).join(" ")}
          </span>
        )}
      </MarkerContent>
    </Marker>
  )
}

/**
 * Un mensaje de la persona (fase 10): con «Editar», que abre el texto en el lugar para volver a preguntar desde ahí.
 * Solo se puede con el hilo listo y con el id del mensaje en el hilo.
 */
export function HumanMessage({ item, canEdit, onEdit }: { item: Human; canEdit: boolean; onEdit: (messageId: string, text: string) => void }) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const editable = canEdit && Boolean(item.messageId)
  const editing = draft !== null && editable

  if (editing) {
    const trimmed = draft.trim()
    const canSubmit = trimmed.length > 0 && draft.length <= MAX_CHARS && trimmed !== item.text.trim()
    const submit = (event?: React.FormEvent) => {
      event?.preventDefault()
      if (!canSubmit) return
      setDraft(null)
      onEdit(item.messageId!, trimmed)
    }
    return (
      <Message align="end">
        <MessageContent>
          <form onSubmit={submit} className="w-full max-w-[85%] self-end">
            <InputGroup className="rounded-2xl bg-background shadow-sm">
              <InputGroupTextarea
                aria-label="Editar el mensaje"
                autoFocus
                value={draft}
                rows={2}
                className="max-h-48 min-h-16 px-4 pt-3 text-[0.95rem]"
                onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setDraft(null)
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e)
                }}
              />
              <InputGroupAddon align="block-end" className="px-3 pb-3">
                <InputGroupText className="hidden text-xs text-muted-foreground sm:inline">
                  {draft.length > MAX_CHARS * 0.8 ? `${draft.length} / ${MAX_CHARS}` : "Lo que venía después se reemplaza"}
                </InputGroupText>
                <InputGroupButton type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setDraft(null)}>
                  Cancelar
                </InputGroupButton>
                <InputGroupButton type="submit" variant="default" size="sm" disabled={!canSubmit}>
                  Volver a preguntar
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
        </MessageContent>
      </Message>
    )
  }

  return (
    <Message align="end">
      <MessageContent>
        <Bubble variant="secondary" align="end">
          <BubbleContent className="text-[0.95rem] whitespace-pre-wrap">{item.text}</BubbleContent>
        </Bubble>
        {item.branch && <BranchMarker branch={item.branch} />}
        {editable && (
          <MessageFooter className="-mt-1.5 px-0">
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              onClick={() => setDraft(item.text)}
            >
              <PencilIcon data-icon="inline-start" />
              Editar
            </Button>
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  )
}
