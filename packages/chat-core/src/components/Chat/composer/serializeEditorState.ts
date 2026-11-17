// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { LexicalNode } from 'lexical'
import { $getRoot, $getSelection, $isElementNode, $isLineBreakNode, $isRangeSelection, $isTextNode } from 'lexical'
import { $isAgentMentionPillNode } from './nodes/AgentMentionPillNode.js'

function $serializeChild(child: LexicalNode): string {
  // A picked mention hands agent selection off to setActiveAgent() (see MessageInput.tsx) -
  // same as today's plain-textarea removeMention() path, which also emits nothing into the
  // outgoing query text. The pill is purely a visual echo of that choice.
  if ($isAgentMentionPillNode(child)) return ''
  if ($isLineBreakNode(child)) return '\n'
  return child.getTextContent()
}

/** Walks the editor tree and produces the plain-text form sent to agent:run. */
export function $serializeEditorState(): string {
  const root = $getRoot()
  const parts: string[] = []
  for (const paragraph of root.getChildren()) {
    if (parts.length > 0) parts.push('\n')
    if (!$isElementNode(paragraph)) continue
    for (const child of paragraph.getChildren()) parts.push($serializeChild(child))
  }
  const result = parts.join('')
  return /^\n+$/.test(result) ? '' : result
}

/**
 * Serializes only the text preceding the cursor, so mention-query extraction (which agent
 * name is being typed after `@`) sees an accurate prefix even mid-content.
 */
export function $getTextBeforeCursor(): string {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return $serializeEditorState()

  const anchor = selection.anchor
  const anchorKey = anchor.key
  const anchorOffset = anchor.offset

  const root = $getRoot()
  const parts: string[] = []

  for (const paragraph of root.getChildren()) {
    if (parts.length > 0) parts.push('\n')

    if (paragraph.getKey() === anchorKey) {
      if (!$isElementNode(paragraph)) return parts.join('')
      const children = paragraph.getChildren()
      for (let i = 0; i < anchorOffset && i < children.length; i++) parts.push($serializeChild(children[i]))
      return parts.join('')
    }

    if (!$isElementNode(paragraph)) continue

    let found = false
    for (const child of paragraph.getChildren()) {
      if (child.getKey() === anchorKey) {
        if ($isTextNode(child)) {
          parts.push(child.getTextContent().slice(0, anchorOffset))
        } else if (anchorOffset > 0) {
          parts.push($serializeChild(child))
        }
        found = true
        break
      }
      parts.push($serializeChild(child))
    }
    if (found) break
  }

  return parts.join('')
}
