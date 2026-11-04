"use client"

import * as React from "react"
import { Maximize2Icon, TriangleAlertIcon } from "lucide-react"
import { useTheme } from "next-themes"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"

let renderCount = 0

/**
 * Un diagrama Mermaid de una spec, dibujado en el navegador (R3). `mermaid` se carga solo cuando hay un diagrama, con
 * `securityLevel: "strict"` (R6), y se vuelve a dibujar al cambiar el tema. Si el diagrama tiene un error, se muestra
 * el código con un aviso y la página sigue andando.
 */
export function Mermaid({ code, caption }: { code: string; caption?: string }) {
  const { resolvedTheme } = useTheme()
  const [svg, setSvg] = React.useState<string>()
  const [error, setError] = React.useState<string>()

  React.useEffect(() => {
    if (!resolvedTheme) return
    let cancelled = false
    ;(async () => {
      try {
        const mermaid = (await import("mermaid")).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedTheme === "dark" ? "dark" : "neutral",
          // En oscuro, las etiquetas de las flechas llevan el fondo de la tarjeta (el gris por defecto desentona).
          ...(resolvedTheme === "dark" && { themeVariables: { edgeLabelBackground: "#171717" } }),
          fontFamily: "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
          flowchart: { htmlLabels: true, curve: "basis" },
        })
        const { svg } = await mermaid.render(`mermaid-${++renderCount}`, code)
        if (!cancelled) {
          setSvg(svg)
          setError(undefined)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, resolvedTheme])

  if (error) {
    return (
      <div className="not-prose my-6 flex flex-col gap-3">
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>No se pudo dibujar este diagrama</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <pre className="overflow-x-auto rounded-xl border bg-muted/40 p-4 font-mono text-xs">{code}</pre>
      </div>
    )
  }

  return (
    <figure className="not-prose group/diagram relative my-6 rounded-xl border bg-card p-4" data-testid="mermaid-diagram" data-rendered={svg ? "true" : undefined}>
      {svg ? (
        <>
          <div className="overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
          <Dialog>
            <DialogTrigger
              render={
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/diagram:opacity-100 focus-visible:opacity-100"
                  aria-label="Ampliar el diagrama"
                />
              }
            >
              <Maximize2Icon />
            </DialogTrigger>
            <DialogContent className="max-h-[92svh] w-[96vw] max-w-[96vw] overflow-auto sm:max-w-[96vw]">
              <DialogHeader>
                <DialogTitle>{caption ?? "Diagrama"}</DialogTitle>
                <DialogDescription>Desplazá para recorrerlo. Esc para cerrar.</DialogDescription>
              </DialogHeader>
              <div className="overflow-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-none [&_svg]:min-w-[60rem]" dangerouslySetInnerHTML={{ __html: svg }} />
            </DialogContent>
          </Dialog>
        </>
      ) : (
        <Skeleton className="h-48 w-full rounded-lg" />
      )}
      {caption && <figcaption className="mt-3 text-center text-xs text-muted-foreground">{caption}</figcaption>}
    </figure>
  )
}
