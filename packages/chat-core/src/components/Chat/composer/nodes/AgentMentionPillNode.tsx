// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type {
  DOMConversionMap,
  DOMConversionOutput,
  DOMExportOutput,
  LexicalEditor,
  NodeKey,
  SerializedLexicalNode,
} from 'lexical'
import { $getNodeByKey, DecoratorNode } from 'lexical'
import { useCallback } from 'react'
import type React from 'react'

export interface SerializedAgentMentionPillNode extends SerializedLexicalNode {
  displayName: string
  fqn: string
}

interface AgentMentionPillComponentProps {
  displayName: string
  nodeKey: NodeKey
  editor: LexicalEditor
}

function AgentMentionPillComponent({ displayName, nodeKey, editor }: AgentMentionPillComponentProps) {
  const handleRemove = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if (node) node.remove()
    })
  }, [editor, nodeKey])

  return (
    <span className="agent-mention-pill" data-testid="agent-mention-pill">
      @{displayName}
      <button
        type="button"
        className="agent-mention-pill-remove"
        aria-label={`Remove ${displayName}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleRemove}
      >✕</button>
    </span>
  )
}

/** Inline pill echoing an @-mention agent switch - see MessageInput.tsx's selectMention(). */
export class AgentMentionPillNode extends DecoratorNode<React.JSX.Element> {
  __displayName: string
  __fqn: string

  static override getType(): string {
    return 'agent-mention-pill'
  }

  static override clone(node: AgentMentionPillNode): AgentMentionPillNode {
    return new AgentMentionPillNode(node.__displayName, node.__fqn, node.__key)
  }

  constructor(displayName: string, fqn: string, key?: NodeKey) {
    super(key)
    this.__displayName = displayName
    this.__fqn = fqn
  }

  override createDOM(): HTMLElement {
    const span = document.createElement('span')
    span.style.display = 'inline'
    return span
  }

  override updateDOM(): false {
    return false
  }

  getDisplayName(): string {
    return this.__displayName
  }

  getFqn(): string {
    return this.__fqn
  }

  // Deliberately empty: mention pills switch the active agent (setActiveAgent) rather than
  // appearing in the outgoing query text - see serializeEditorState.ts's $serializeChild().
  override getTextContent(): string {
    return ''
  }

  override isInline(): boolean {
    return true
  }

  override isKeyboardSelectable(): boolean {
    return true
  }

  override decorate(editor: LexicalEditor): React.JSX.Element {
    return <AgentMentionPillComponent displayName={this.__displayName} nodeKey={this.__key} editor={editor} />
  }

  override exportJSON(): SerializedAgentMentionPillNode {
    return { type: 'agent-mention-pill', version: 1, displayName: this.__displayName, fqn: this.__fqn }
  }

  static override importJSON(serializedNode: Record<string, unknown>): AgentMentionPillNode {
    const { displayName, fqn } = serializedNode as Partial<SerializedAgentMentionPillNode>
    return $createAgentMentionPillNode(displayName ?? '', fqn ?? '')
  }

  override exportDOM(): DOMExportOutput {
    const element = document.createElement('span')
    element.setAttribute('data-lexical-agent-mention-fqn', this.__fqn)
    element.setAttribute('data-lexical-agent-mention-name', this.__displayName)
    element.textContent = `@${this.__displayName}`
    return { element }
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: HTMLElement) => {
        const fqn = domNode.getAttribute('data-lexical-agent-mention-fqn')
        if (!fqn) return null
        const displayName = domNode.getAttribute('data-lexical-agent-mention-name') ?? fqn
        return {
          conversion: (): DOMConversionOutput => ({ node: $createAgentMentionPillNode(displayName, fqn) }),
          priority: 1,
        }
      },
    }
  }
}

export function $createAgentMentionPillNode(displayName: string, fqn: string): AgentMentionPillNode {
  return new AgentMentionPillNode(displayName, fqn)
}

export function $isAgentMentionPillNode(node: unknown): node is AgentMentionPillNode {
  return node instanceof AgentMentionPillNode
}
