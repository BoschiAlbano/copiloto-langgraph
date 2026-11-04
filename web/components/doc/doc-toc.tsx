"use client"

import * as React from "react"
import type { TocItem } from "@/lib/docs-core"
import { cn } from "@/lib/utils"

/** «En esta página» (R4): los títulos del documento, con el que se está leyendo marcado. */
export function DocToc({ items }: { items: TocItem[] }) {
  const [active, setActive] = React.useState<string>()

  React.useEffect(() => {
    const headings = items.map((i) => document.getElementById(i.id)).filter((h): h is HTMLElement => h !== null)
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { rootMargin: "-80px 0px -70% 0px" },
    )
    headings.forEach((h) => observer.observe(h))
    return () => observer.disconnect()
  }, [items])

  // Al abrir un link a una sección (#…), los diagramas que están arriba se dibujan después y empujan el contenido:
  // se vuelve a la sección mientras se dibujan, salvo que la persona ya se haya movido.
  React.useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1))
    if (!id) return
    let moved = false
    const stop = () => (moved = true)
    const events = ["wheel", "touchmove", "keydown", "mousedown"] as const
    events.forEach((e) => window.addEventListener(e, stop, { passive: true }))
    const timers = [300, 800, 1500, 2500, 4000].map((ms) =>
      setTimeout(() => {
        if (!moved) document.getElementById(id)?.scrollIntoView({ block: "start" })
      }, ms),
    )
    return () => {
      timers.forEach(clearTimeout)
      events.forEach((e) => window.removeEventListener(e, stop))
    }
  }, [])

  if (items.length === 0) return null
  return (
    <nav aria-label="En esta página" className="flex flex-col gap-2 text-sm">
      <p className="font-medium">En esta página</p>
      <ul className="flex flex-col gap-1.5 border-l">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className={cn(
                "-ml-px block border-l border-transparent py-0.5 text-muted-foreground transition-colors hover:text-foreground",
                item.depth === 2 ? "pl-3" : "pl-6 text-xs",
                active === item.id && "border-foreground font-medium text-foreground",
              )}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
