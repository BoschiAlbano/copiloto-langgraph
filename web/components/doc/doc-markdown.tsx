import * as React from "react"
import Link from "next/link"
import ReactMarkdown, { type Components } from "react-markdown"
import rehypeSlug from "rehype-slug"
import remarkGfm from "remark-gfm"
import { rewriteDocLink, type DocEntry } from "@/lib/docs-core"
import { Mermaid } from "./mermaid"

/** El texto de un nodo de React (para leer el código de un bloque). */
function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children)
  return ""
}

/**
 * Un documento de `/doc` con tipografía de lectura (R4). No interpreta HTML (R6). Los bloques ```mermaid se dibujan
 * (R3); los títulos llevan id (rehype-slug) para el índice; los links a otros documentos van a su página de `/doc`.
 */
export function DocMarkdown({ markdown, registry }: { markdown: string; registry: DocEntry[] }) {
  const components: Components = {
    pre: ({ children }) => {
      const child = React.Children.only(children) as React.ReactElement<{ className?: string; children?: React.ReactNode }>
      const language = /language-(\w+)/.exec(child?.props?.className ?? "")?.[1]
      const code = textOf(child?.props?.children).replace(/\n$/, "")
      if (language === "mermaid") return <Mermaid code={code} />
      return (
        <pre className="not-prose my-5 overflow-x-auto rounded-xl border bg-muted/40 p-4 font-mono text-[0.8rem] leading-relaxed">
          <code>{code}</code>
        </pre>
      )
    },
    a: ({ href = "", children }) => {
      const target = rewriteDocLink(href, registry)
      if (target.startsWith("/doc") || target.startsWith("#")) return <Link href={target}>{children}</Link>
      if (/^https?:/.test(target)) {
        return (
          <a href={target} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        )
      }
      // Un link a un archivo del código (src/…): no hay página para eso; se muestra como texto.
      return <span className="font-medium">{children}</span>
    },
    table: ({ children }) => (
      <div className="not-prose my-6 overflow-x-auto rounded-xl border">
        <table className="w-full border-collapse text-sm [&_td]:border-t [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.8em]">
          {children}
        </table>
      </div>
    ),
  }
  return (
    <div className="prose prose-neutral max-w-none dark:prose-invert prose-headings:scroll-mt-20 prose-headings:font-semibold prose-h2:mt-12 prose-h2:border-b prose-h2:pb-2 prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-a:underline-offset-3 prose-li:my-1">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
