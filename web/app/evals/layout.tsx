import { ObsHeader } from "@/components/observability/obs-header"

export default function EvalsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <ObsHeader current="evals" />
      {children}
    </div>
  )
}
