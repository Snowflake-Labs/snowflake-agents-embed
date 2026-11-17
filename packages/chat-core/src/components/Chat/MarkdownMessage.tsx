// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { Components } from 'react-markdown'

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [['href', /^(?!javascript:)/i], 'title', 'target', 'rel'],
  },
}

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  const trimmed = href.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return undefined
}

const components: Components = {
  a({ href, children, ref: _ref, ...rest }) {
    const allowed = safeHref(href)
    if (!allowed) return <span>{children}</span>
    return (
      <a href={allowed} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    )
  },
  pre({ children }) {
    return (
      <div className="md-pre-wrap">
        <pre>{children}</pre>
        <CopyCodeButton getCode={() => extractText(children)} />
      </div>
    )
  },
}

interface Props {
  text: string
  streaming?: boolean
}

function MarkdownMessageImpl({ text, streaming }: Props) {
  return (
    <div className="md-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="cursor">▌</span>}
    </div>
  )
}

/**
 * Memoized because a full remark/rehype parse of the answer is the single most expensive thing
 * in a streamed render. The parse itself can't be made incremental behind react-markdown's API,
 * so the lever is how often it runs: never for a finished turn whose text hasn't changed, and -
 * thanks to useAgentStream's per-frame delta coalescing - at most once a frame for the live one.
 */
export const MarkdownMessage = memo(MarkdownMessageImpl)

function CopyCodeButton({ getCode }: { getCode: () => string }) {
  async function handleCopy() {
    await navigator.clipboard.writeText(getCode()).catch(() => {})
  }
  return (
    <button className="copy-code-btn" onClick={handleCopy} title="Copy code">
      Copy
    </button>
  )
}

function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in (node as any)) {
    return extractText((node as any).props.children)
  }
  return ''
}
