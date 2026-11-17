// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createParagraphNode, $createTextNode, $getNodeByKey, $getRoot, $isElementNode, $isTextNode } from 'lexical'
import type { TextNode } from 'lexical'
import { useEffect, useRef } from 'react'

interface Props {
  /** Final committed speech-to-text segment to append, or null when dictation is idle. */
  committedText: string | null
  onCommittedTextAppended: () => void
  /** Live, not-yet-final speech-to-text for the segment in progress. null/'' when there is none. */
  interimText: string | null
}

function leadingSeparator(): string {
  const textContent = $getRoot().getTextContent()
  const hasContent = textContent.length > 0 && !/^\n+$/.test(textContent)
  return hasContent ? ' ' : ''
}

function appendTextNode(text: string): TextNode {
  const root = $getRoot()
  const lastChild = root.getLastChild()
  const textNode = $createTextNode(text)
  if (lastChild && $isElementNode(lastChild)) {
    lastChild.append(textNode)
  } else {
    const paragraph = $createParagraphNode()
    paragraph.append(textNode)
    root.append(paragraph)
  }
  return textNode
}

/**
 * Appends dictation transcripts into the editor as one node whose lifecycle spans a whole
 * segment: created on the first interim frame, rewritten in place as the recognizer revises
 * it, then promoted to plain (non-interim-styled) text the moment the segment finalizes -
 * never a fresh node per revision. A fresh-node-per-update approach (the original
 * finals-only implementation appended one TextNode per commit) would duplicate text on every
 * revision the browser's recognizer makes to a not-yet-final segment, since each revision of
 * the *same* utterance would land as a separate insert. Tagged 'voice-append' so
 * OnChangePlugin doesn't re-scan every interim frame (many per second) as a mention-query
 * change.
 */
export function VoiceAppendPlugin({ committedText, onCommittedTextAppended, interimText }: Props): null {
  const [editor] = useLexicalComposerContext()
  const interimKeyRef = useRef<string | null>(null)
  // The separator computed once, when the interim node is first created - reused verbatim on
  // later interim revisions and on final promotion of that same node, since recomputing it
  // after the node already exists would see the node's own prior text as "content already
  // there" and never re-add the separator it started with.
  const interimSeparatorRef = useRef('')
  const lastCommittedRef = useRef<string | null>(null)

  // Live interim: replace the same node's text in place. A null/empty interim with no final
  // pending (an aborted or cancelled utterance) removes the node so it leaves no trace.
  useEffect(() => {
    editor.update(() => {
      const key = interimKeyRef.current
      const node = key ? $getNodeByKey(key) : null
      const live = node && $isTextNode(node) ? node : null

      if (!interimText) {
        live?.remove()
        interimKeyRef.current = null
        return
      }
      if (live) {
        live.setTextContent(interimSeparatorRef.current + interimText)
      } else {
        interimSeparatorRef.current = leadingSeparator()
        const created = appendTextNode(interimSeparatorRef.current + interimText)
        created.setStyle('opacity: 0.6')
        interimKeyRef.current = created.getKey()
      }
    }, { tag: 'voice-append' })
  }, [editor, interimText])

  // Final: promote the live interim node to plain committed text and release its key, so the
  // next interim frame starts a fresh node rather than silently rewriting text the user
  // already sees as committed. Falls back to appending fresh text when a final arrives with
  // no interim node live (a segment can finalize without ever reporting an interim).
  useEffect(() => {
    if (committedText === null) {
      lastCommittedRef.current = null
      return
    }
    if (committedText === lastCommittedRef.current) return
    lastCommittedRef.current = committedText

    editor.update(() => {
      const key = interimKeyRef.current
      const node = key ? $getNodeByKey(key) : null
      const live = node && $isTextNode(node) ? node : null

      if (live) {
        live.setTextContent(interimSeparatorRef.current + committedText)
        live.setStyle('')
      } else {
        appendTextNode(leadingSeparator() + committedText)
      }
      interimKeyRef.current = null
    }, { tag: 'voice-append' })

    onCommittedTextAppended()
  }, [editor, committedText, onCommittedTextAppended])

  return null
}
