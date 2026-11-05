import { percent } from "@copilot/observability/eval-report"
import { cn } from "@/lib/utils"

/** Los aciertos de una categoría como una barra: verde lo que pasó, el resto vacío. */
export function CategoryBar({ passed, total, className }: { passed: number; total: number; className?: string }) {
  const pct = total ? (passed / total) * 100 : 0
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={passed}
        aria-label={`${passed} de ${total}`}
      >
        <div className={cn("h-full rounded-full", passed === total ? "bg-primary" : "bg-primary/60")} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {passed}/{total} · {percent(passed, total)}
      </span>
    </div>
  )
}
