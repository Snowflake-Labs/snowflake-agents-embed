// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useEffect } from 'react'
import { $getTextBeforeCursor, $serializeEditorState } from '../serializeEditorState.js'

interface Props {
  onChange: (text: string, textBeforeCursor: string) => void
}

/**
 * Bridges Lexical editor content changes back to React state. Skips updates tagged
 * 'programmatic' (setText/clearEditor) and 'voice-append' (VoiceAppendPlugin) so those don't
 * re-trigger mention-query scanning for a change the caller already knows about.
 */
export function OnChangePlugin({ onChange }: Props): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, tags }) => {
      if (tags.has('programmatic') || tags.has('voice-append')) return
      let text = ''
      let textBeforeCursor = ''
      editorState.read(() => {
        text = $serializeEditorState()
        textBeforeCursor = $getTextBeforeCursor()
      })
      onChange(text, textBeforeCursor)
    })
  }, [editor, onChange])

  return null
}
