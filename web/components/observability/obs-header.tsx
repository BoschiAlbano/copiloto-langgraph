import Link from "next/link"
import { ArrowLeftIcon, FlaskConicalIcon, WaypointsIcon } from "lucide-react"
import { ThemeToggle } from "@/components/theme-toggle"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** El encabezado de las páginas de observabilidad (fase 11): volver al chat, trazas y evaluaciones. */
export function ObsHeader({ current }: { current: "traces" | "evals" }) {
  const tab = (href: string, active: boolean, icon: React.ReactNode, label: string) => (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" }), "gap-1.5")}
    >
      {icon}
      {label}
    </Link>
  )
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur">
      <Link href="/" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5 text-muted-foreground")}>
        <ArrowLeftIcon />
        <span className="hidden sm:inline">Chat</span>
      </Link>
      <nav aria-label="Observabilidad" className="flex flex-1 items-center gap-1">
        {tab("/traces", current === "traces", <WaypointsIcon />, "Trazas")}
        {tab("/evals", current === "evals", <FlaskConicalIcon />, "Evaluaciones")}
      </nav>
      <ThemeToggle />
    </header>
  )
}

/** El contenedor de una página de observabilidad: ancho de lectura de tablas, con margen en el celular. */
export function ObsMain({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">{children}</main>
}

export function ObsTitle({ title, description, children }: { title: string; description?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  )
}
