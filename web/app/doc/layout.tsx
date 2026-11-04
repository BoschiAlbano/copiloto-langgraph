import { DocSidebar, type DocNavItem } from "@/components/doc/doc-sidebar"
import { ThemeToggle } from "@/components/theme-toggle"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { getRegistry, loadAll } from "@/lib/docs"
import { shortTitle } from "@/lib/docs-core"

export const dynamic = "force-dynamic"

export default async function DocLayout({ children }: { children: React.ReactNode }) {
  const docs = await loadAll(await getRegistry())
  const items: DocNavItem[] = docs.map(({ entry, meta }) => ({
    slug: entry.slug,
    group: entry.group,
    label: entry.label,
    title: shortTitle(meta.title),
    ...(meta.status && { status: meta.status }),
  }))
  return (
    <SidebarProvider>
      <DocSidebar items={items} />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur">
          <SidebarTrigger />
          <span className="flex-1 truncate text-sm font-medium">Documentación del proyecto</span>
          <ThemeToggle />
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}
