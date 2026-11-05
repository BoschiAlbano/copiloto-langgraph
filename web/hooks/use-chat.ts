"use client"

import * as React from "react"
import type { HumanDecision } from "@copilot/graph/approval"
import type { ThreadView } from "@copilot/web/handlers"
import {
  applyEvent,
  connectionLost,
  fromThreadView,
  leftActionsNotice,
  startContinuation,
  startFork,
  startMessage,
  type PageState,
} from "@copilot/web/turn-view"
import { ApiError, openBranch as postBranch, streamTurn } from "@/lib/api"

/**
 * El estado de la página de un hilo y lo que la persona puede hacer: mandar un mensaje, decidir sobre la tarjeta,
 * continuar un turno a medias, o editar o reintentar un turno anterior (fase 10). Toda la lógica de "qué se ve" está
 * en el reductor (`@copilot/web/turn-view`).
 */
export function useChat(initial: ThreadView, { onTurnEnd }: { onTurnEnd?: () => void } = {}) {
  const [state, setState] = React.useState<PageState>(() => fromThreadView(initial))
  const stateRef = React.useRef(state)
  stateRef.current = state

  // El estado inicial se toma UNA vez: cada hilo monta su propio componente (la página usa `key`), y si el servidor
  // vuelve a dibujar la página con otro `initial`, no se pisa la conversación en curso.

  const run = React.useCallback(
    async (start: (s: PageState) => PageState, path: string, body: unknown) => {
      const previous = stateRef.current
      if (previous.status === "running") return
      setState(start(previous))
      let finished = false
      try {
        await streamTurn(path, body, (event) => {
          if (event.type === "done" || event.type === "error") finished = true
          setState((s) => applyEvent(s, event))
        })
        if (!finished) setState((s) => connectionLost(s))
      } catch (error) {
        if (error instanceof ApiError) {
          // El pedido no llegó a empezar (por ejemplo, otra pestaña tiene un turno en curso): la página vuelve atrás.
          setState({ ...previous, notice: error.message })
        } else {
          setState((s) => connectionLost(s))
        }
      } finally {
        onTurnEnd?.()
      }
    },
    [onTurnEnd],
  )

  const threadPath = `/api/threads/${initial.threadId}`
  const send = React.useCallback((text: string) => run((s) => startMessage(s, text), `${threadPath}/messages`, { text }), [run, threadPath])
  const decide = React.useCallback(
    (decision: HumanDecision) => run((s) => startContinuation(s, decision), `${threadPath}/decision`, decision),
    [run, threadPath],
  )
  const resume = React.useCallback(() => run((s) => startContinuation(s), `${threadPath}/continue`, {}), [run, threadPath])
  const edit = React.useCallback(
    (messageId: string, text: string) => run((s) => startFork(s, messageId, text), `${threadPath}/edit`, { messageId, text }),
    [run, threadPath],
  )
  const retry = React.useCallback((messageId: string) => run((s) => startFork(s, messageId), `${threadPath}/retry`, { messageId }), [run, threadPath])
  // Abrir otra versión (ramas del hilo): no corre ningún turno. La página se arma de nuevo con el hilo como queda, igual
  // que al recargar, y conserva lo que gastó la sesión. Devuelve true si se abrió.
  const openBranch = React.useCallback(
    async (checkpointId: string) => {
      const previous = stateRef.current
      if (previous.status !== "ready") return false
      try {
        const view = await postBranch(initial.threadId, checkpointId)
        setState((s) => ({ ...fromThreadView(view.thread), session: s.session, notice: leftActionsNotice(view.leftActions) }))
        return true
      } catch (error) {
        setState((s) => ({ ...s, notice: error instanceof Error ? error.message : "No se pudo cambiar de versión." }))
        return false
      } finally {
        onTurnEnd?.()
      }
    },
    [initial.threadId, onTurnEnd],
  )
  const dismissNotice = React.useCallback(() => setState((s) => ({ ...s, notice: undefined })), [])

  return { state, send, decide, resume, edit, retry, openBranch, dismissNotice }
}
