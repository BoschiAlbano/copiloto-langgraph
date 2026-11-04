"use client"

import Link from "next/link"
import { BookmarkIcon, MessageCircleIcon, PauseCircleIcon, PlusIcon, ScissorsIcon, TriangleAlertIcon } from "lucide-react"
import type { ThreadSummary } from "@copilot/graph/threads"
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
import { since } from "@/lib/format"

/** La barra de hilos (R2): los recientes, «Nuevo hilo» y la memoria del negocio. */
export function AppSidebar({
  threads,
  currentId,
  onOpenMemory,
}: {
  threads: ThreadSummary[]
  currentId: string
  onOpenMemory: () => void
}) {
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ScissorsIcon className="size-4" aria-hidden />
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">Copiloto</span>
            <span className="truncate text-xs text-muted-foreground">Gestión de la barbería</span>
          </div>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Recarga completa a propósito: un hilo nuevo arranca de cero. */}
            <SidebarMenuButton render={<a href="/" />}>
              <PlusIcon />
              <span>Nuevo hilo</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Hilos recientes</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {threads.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">Todavía no hay conversaciones.</p>}
              {threads.map((t) => (
                <SidebarMenuItem key={t.threadId}>
                  <SidebarMenuButton
                    isActive={t.threadId === currentId}
                    className="h-auto py-2"
                    render={<Link href={`/threads/${t.threadId}`} />}
                  >
                    {t.awaiting ? <PauseCircleIcon /> : t.pending ? <TriangleAlertIcon /> : <MessageCircleIcon />}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{t.firstMessage || t.threadId}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {since(t.lastActivity)}
                        {t.awaiting ? " · espera tu decisión" : t.pending ? " · a medias" : ` · ${t.messageCount} mensajes`}
                      </span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onOpenMemory}>
              <BookmarkIcon />
              <span>Memoria del negocio</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
