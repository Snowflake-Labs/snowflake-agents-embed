// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import React, { forwardRef, useImperativeHandle, useRef } from 'react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { EditorRefPlugin } from '@lexical/react/LexicalEditorRefPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import type { LexicalEditor } from 'lexical'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
} from 'lexical'
import { AgentMentionPillNode, $createAgentMentionPillNode } from './nodes/AgentMentionPillNode.js'
import { AutoResizePlugin } from './plugins/AutoResizePlugin.js'
import { EditablePlugin } from './plugins/EditablePlugin.js'
import { EnterToSendPlugin } from './plugins/EnterToSendPlugin.js'
import { EscapeClearPlugin } from './plugins/EscapeClearPlugin.js'
import { OnChangePlugin } from './plugins/OnChangePlugin.js'
import { PasteFilesPlugin } from './plugins/PasteFilesPlugin.js'
import { VoiceAppendPlugin } from './plugins/VoiceAppendPlugin.js'

export interface LexicalComposerInputHandle {
  focus: () => void
  clearEditor: () => void
  setText: (text: string) => void
  insertMentionPillAtCursor: (fqn: string, displayName: string) => void
  removeMentionTriggerAtCursor: () => void
}

export interface LexicalComposerInputProps {
  onChange: (text: string, textBeforeCursor: string) => void
  onSubmit: () => void
  onEscape: () => void
  onPasteFiles: ((files: FileList) => void) | undefined
  disabled?: boolean
  placeholder: string
  isMentionMenuOpen: boolean
  committedVoiceText: string | null
  onCommittedVoiceTextAppended: () => void
  /** Live, not-yet-final dictation text for the segment in progress. */
  interimVoiceText?: string | null
  'aria-label'?: string
}

const PARAGRAPH_CLASS = 'lexical-composer-paragraph'

function applyEditorText(editor: LexicalEditor | null, text: string) {
  editor?.update(() => {
    const root = $getRoot()
    root.clear()
    const paragraph = $createParagraphNode()
    if (text) paragraph.append($createTextNode(text))
    root.append(paragraph)
    paragraph.selectEnd()
  }, { tag: 'programmatic' })
}

export const LexicalComposerInput = forwardRef<LexicalComposerInputHandle, LexicalComposerInputProps>(
  function LexicalComposerInput(props, ref) {
    const {
      onChange, onSubmit, onEscape, onPasteFiles, disabled, placeholder,
      isMentionMenuOpen, committedVoiceText, onCommittedVoiceTextAppended, interimVoiceText,
    } = props

    const editorRef = useRef<LexicalEditor | null>(null)

    useImperativeHandle(ref, () => ({
      focus: () => editorRef.current?.focus(),
      clearEditor: () => applyEditorText(editorRef.current, ''),
      setText: (text: string) => applyEditorText(editorRef.current, text),
      insertMentionPillAtCursor: (fqn: string, displayName: string) => {
        editorRef.current?.update(() => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection)) return
          const anchor = selection.anchor
          const anchorNode = anchor.getNode()
          const pill = $createAgentMentionPillNode(displayName, fqn)
          const trailing = $createTextNode(' ')

          if ($isTextNode(anchorNode)) {
            const text = anchorNode.getTextContent()
            const offset = anchor.offset
            const atIdx = text.lastIndexOf('@', offset - 1)
            if (atIdx !== -1) {
              const before = text.slice(0, atIdx)
              const after = text.slice(offset)
              anchorNode.setTextContent(before)
              anchorNode.insertAfter(pill)
              pill.insertAfter(trailing)
              if (after) {
                const afterNode = $createTextNode(after)
                trailing.insertAfter(afterNode)
              }
              trailing.select(1, 1)
              return
            }
          }
          selection.insertNodes([pill, trailing])
          trailing.select(1, 1)
        })
      },
      removeMentionTriggerAtCursor: () => {
        editorRef.current?.update(() => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection)) return
          const anchor = selection.anchor
          const anchorNode = anchor.getNode()
          if (!$isTextNode(anchorNode)) return
          const text = anchorNode.getTextContent()
          const offset = anchor.offset
          const atIdx = text.lastIndexOf('@', offset - 1)
          if (atIdx === -1) return
          const before = text.slice(0, atIdx)
          const after = text.slice(offset)
          anchorNode.setTextContent(before + after)
          anchorNode.select(before.length, before.length)
        })
      },
    }), [])

    const initialConfig = {
      namespace: 'AgentsEmbedComposer',
      theme: { paragraph: PARAGRAPH_CLASS },
      nodes: [AgentMentionPillNode],
      onError: (error: Error) => console.error('Lexical editor error:', error),
      editable: !disabled,
    }

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <div className="lexical-composer-input-container">
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                className="lexical-composer-input"
                aria-label={props['aria-label'] ?? 'Message'}
                data-testid="lexical-composer-input"
              />
            }
            placeholder={<div className="lexical-composer-placeholder" aria-hidden="true">{placeholder}</div>}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <EditorRefPlugin editorRef={editorRef} />
          <EditablePlugin editable={!disabled} />
          <OnChangePlugin onChange={onChange} />
          <EnterToSendPlugin onSubmit={onSubmit} disabled={Boolean(disabled)} isMenuOpen={isMentionMenuOpen} />
          <EscapeClearPlugin onEscape={onEscape} />
          <PasteFilesPlugin onPasteFiles={onPasteFiles} />
          <AutoResizePlugin />
          <VoiceAppendPlugin
            committedText={committedVoiceText}
            onCommittedTextAppended={onCommittedVoiceTextAppended}
            interimText={interimVoiceText ?? null}
          />
        </div>
      </LexicalComposer>
    )
  },
)
