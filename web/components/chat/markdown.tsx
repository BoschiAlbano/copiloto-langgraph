"use client"

import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

// El texto de los agentes viene con Markdown sencillo (negritas, listas, a veces una tabla). Se dibuja con
// react-markdown, que NO interpreta HTML: un texto que llegue de la base con etiquetas se ve como texto. Un salto de
// línea suelto se respeta (remark-breaks): los reportes los arma el código, renglón por renglón.
const components: Components = {
  p: ({ className, ...props }) => <p className={cn("leading-relaxed [&:not(:first-child)]:mt-3", className)} {...props} />,
  ul: ({ className, ...props }) => <ul className={cn("mt-2 flex list-disc flex-col gap-1 pl-5", className)} {...props} />,
  ol: ({ className, ...props }) => <ol className={cn("mt-2 flex list-decimal flex-col gap-1 pl-5", className)} {...props} />,
  strong: ({ className, ...props }) => <strong className={cn("font-semibold", className)} {...props} />,
  h1: ({ className, ...props }) => <h3 className={cn("mt-4 font-semibold first:mt-0", className)} {...props} />,
  h2: ({ className, ...props }) => <h3 className={cn("mt-4 font-semibold first:mt-0", className)} {...props} />,
  h3: ({ className, ...props }) => <h4 className={cn("mt-3 font-semibold first:mt-0", className)} {...props} />,
  a: ({ className, ...props }) => <a className={cn("underline underline-offset-3", className)} target="_blank" rel="noreferrer noopener" {...props} />,
  table: ({ className, ...props }) => (
    <div className="mt-3 overflow-x-auto rounded-lg border">
      <table className={cn("w-full text-sm", className)} {...props} />
    </div>
  ),
  th: ({ className, ...props }) => <th className={cn("border-b bg-muted/50 px-3 py-1.5 text-left font-medium", className)} {...props} />,
  td: ({ className, ...props }) => <td className={cn("border-b px-3 py-1.5 last:border-b-0", className)} {...props} />,
  code: ({ className, ...props }) => <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]", className)} {...props} />,
}

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
      {text}
    </ReactMarkdown>
  )
}
