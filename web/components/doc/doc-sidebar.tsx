"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { BookOpenIcon, CheckCircle2Icon, CircleDashedIcon, FileTextIcon, LayoutGridIcon, MapIcon, MessageCircleIcon, NetworkIcon } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import type { DocGroup } from "@/lib/docs-core"

export interface DocNavItem {
  slug: string
  group: DocGroup
  label: string
  /** El título sin el «Fase N:» (para las fases). */
  title: string
  status?: string
}

const ICONS: Record<string, typeof FileTextIcon> = { inicio: BookOpenIcon, plan: MapIcon, "mapa-del-grafo": NetworkIcon }

/** La barra de la documentación (R4): todo el contenido, agrupado, con la página actual marcada. */
export function DocSidebar({ items }: { items: DocNavItem[] }) {
  const pathname = usePathname()
  const groups: { group: DocGroup; label: string }[] = [
    { group: "intro", label: "Empezar" },
    { group: "phase", label: "Fases" },
    { group: "reference", label: "Referencia" },
  ]
  return (
    <Sidebar>
      <SidebarHeader>
        <Link href="/doc" className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BookOpenIcon className="size-4" aria-hidden />
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">Documentación</span>
            <span className="truncate text-xs text-muted-foreground">Copiloto con LangGraph</span>
          </div>
        </Link>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={pathname === "/doc"} render={<Link href="/doc" />}>
              <LayoutGridIcon />
              <span>Portada</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {groups.map(({ group, label }) => (
          <SidebarGroup key={group}>
            <SidebarGroupLabel>{label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items
                  .filter((i) => i.group === group)
                  .map((item) => {
                    const Icon = group === "phase" ? (item.status === "terminada" ? CheckCircle2Icon : CircleDashedIcon) : (ICONS[item.slug] ?? FileTextIcon)
                    return (
                      <SidebarMenuItem key={item.slug}>
                        <SidebarMenuButton isActive={pathname === `/doc/${item.slug}`} render={<Link href={`/doc/${item.slug}`} />}>
                          <Icon />
                          <span className="truncate">{group === "phase" ? `${item.label} · ${item.title}` : item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href="/" />}>
              <MessageCircleIcon />
              <span>Ir al chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
