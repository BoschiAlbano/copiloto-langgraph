"use client"

import * as React from "react"
import { AlertTriangleIcon, CheckIcon, PencilIcon, ShieldCheckIcon, XIcon } from "lucide-react"
import type { ApprovalRequest, HumanDecision } from "@copilot/graph/approval"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import { paramValue } from "@/lib/format"

const RISK: Record<ApprovalRequest["action"]["risk"], { label: string; variant: "secondary" | "outline" | "destructive" }> = {
  low: { label: "Riesgo bajo", variant: "secondary" },
  medium: { label: "Riesgo medio", variant: "outline" },
  high: { label: "Riesgo alto", variant: "destructive" },
}

const TOOL_TITLES: Record<string, string> = {
  createAppointment: "Agendar un turno",
  cancelAppointment: "Cancelar un turno",
  registerSale: "Registrar una venta",
  adjustStock: "Ajustar el stock",
}

/** Cómo se lee cada parámetro de una acción en la tarjeta. */
const PARAM_LABELS: Record<string, string> = {
  clientId: "Cliente (id)",
  staffName: "Barbero",
  serviceName: "Servicio",
  date: "Fecha",
  time: "Hora",
  appointmentId: "Turno (id)",
  reason: "Motivo",
  paymentMethod: "Medio de pago",
  items: "Productos",
  sku: "Producto (SKU)",
  delta: "Unidades",
}
const labelOf = (key: string) => PARAM_LABELS[key] ?? key

type Mode = "view" | "reject" | "edit"

/**
 * La tarjeta de aprobación (R8). Lo que se ejecuta es lo que se ve: el resumen lo arma el código. Editar no ejecuta
 * nada: el servidor devuelve la tarjeta recalculada, que hay que aprobar de nuevo.
 */
export function ApprovalCard({ request, busy, onDecide }: { request: ApprovalRequest; busy: boolean; onDecide: (decision: HumanDecision) => void }) {
  const { action } = request
  const [mode, setMode] = React.useState<Mode>("view")
  const [comment, setComment] = React.useState("")
  const [draft, setDraft] = React.useState<Record<string, string>>({})
  const [editError, setEditError] = React.useState<string>()
  const risk = RISK[action.risk]

  // Una tarjeta nueva (otra propuesta o la recalculada) vuelve a empezar.
  React.useEffect(() => {
    setMode("view")
    setComment("")
    setEditError(undefined)
    setDraft(Object.fromEntries(Object.entries(action.params).map(([k, v]) => [k, paramValue(v)])))
  }, [action])

  function submitEdit(event: React.FormEvent) {
    event.preventDefault()
    // Cada campo vuelve a su tipo: los números, como números; lo demás, como texto. El servidor valida igual.
    const params: Record<string, unknown> = {}
    for (const [key, original] of Object.entries(action.params)) {
      const raw = (draft[key] ?? "").trim()
      if (typeof original === "number") {
        const n = Number(raw.replace(",", "."))
        if (raw === "" || Number.isNaN(n)) {
          setEditError(`«${labelOf(key)}» tiene que ser un número.`)
          return
        }
        params[key] = n
      } else if (typeof original === "string") params[key] = raw
      else {
        try {
          params[key] = JSON.parse(raw)
        } catch {
          setEditError(`«${labelOf(key)}» no se pudo leer.`)
          return
        }
      }
    }
    setEditError(undefined)
    onDecide({ decision: "edit", params })
  }

  return (
    <Card className="w-full border-primary/30 shadow-md" role="region" aria-label="Acción para aprobar">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheckIcon className="size-4 text-primary" aria-hidden />
          {TOOL_TITLES[action.tool] ?? action.tool}
        </CardTitle>
        <CardDescription className="text-foreground">{action.summary}</CardDescription>
        <CardAction className="flex gap-1.5">
          {request.edited && <Badge variant="secondary">Editada</Badge>}
          <Badge variant={risk.variant}>{risk.label}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {request.error && (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertDescription>{request.error} La propuesta anterior sigue pendiente: no se aprobó ni se cambió nada.</AlertDescription>
          </Alert>
        )}
        {mode === "edit" ? (
          <form id="edit-action" onSubmit={submitEdit}>
            <FieldGroup className="gap-4">
              {Object.entries(action.params).map(([key, value]) => (
                <Field key={key} data-invalid={editError?.includes(`«${labelOf(key)}»`) || undefined}>
                  <FieldLabel htmlFor={`param-${key}`}>{labelOf(key)}</FieldLabel>
                  <Input
                    id={`param-${key}`}
                    inputMode={typeof value === "number" ? "decimal" : undefined}
                    value={draft[key] ?? ""}
                    aria-invalid={editError?.includes(`«${labelOf(key)}»`) || undefined}
                    onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  />
                </Field>
              ))}
              <FieldDescription>{editError ?? "Editar no ejecuta nada: después vas a ver la tarjeta con los cambios para aprobarla."}</FieldDescription>
            </FieldGroup>
          </form>
        ) : (
          <Table>
            <TableBody>
              {Object.entries(action.params).map(([key, value]) => (
                <TableRow key={key}>
                  <TableCell className="w-1/3 text-muted-foreground">{labelOf(key)}</TableCell>
                  <TableCell className="font-medium whitespace-normal">{paramValue(value)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {mode === "reject" && (
          <Field>
            <FieldLabel htmlFor="reject-comment">Motivo (opcional)</FieldLabel>
            <Input id="reject-comment" value={comment} maxLength={200} placeholder="Por ejemplo: mejor otro día" onChange={(e) => setComment(e.target.value)} autoFocus />
          </Field>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap justify-end gap-2">
        {mode === "view" && (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setMode("edit")}>
              <PencilIcon data-icon="inline-start" />
              Editar
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setMode("reject")}>
              <XIcon data-icon="inline-start" />
              Rechazar
            </Button>
            <Button disabled={busy} onClick={() => onDecide({ decision: "approve" })}>
              <CheckIcon data-icon="inline-start" />
              Aprobar
            </Button>
          </>
        )}
        {mode === "reject" && (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setMode("view")}>
              Volver
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => onDecide(comment.trim() ? { decision: "reject", comment: comment.trim() } : { decision: "reject" })}
            >
              <XIcon data-icon="inline-start" />
              Rechazar la acción
            </Button>
          </>
        )}
        {mode === "edit" && (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setMode("view")}>
              Cancelar
            </Button>
            <Button type="submit" form="edit-action" disabled={busy}>
              <PencilIcon data-icon="inline-start" />
              Ver la tarjeta con los cambios
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  )
}
