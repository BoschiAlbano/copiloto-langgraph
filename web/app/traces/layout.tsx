import { ObsHeader } from "@/components/observability/obs-header"

export default function TracesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <ObsHeader current="traces" />
      {children}
    </div>
  )
}
