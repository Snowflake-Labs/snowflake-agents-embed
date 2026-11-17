// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { COMMAND_PRIORITY_HIGH, KEY_ESCAPE_COMMAND } from 'lexical'
import { useEffect } from 'react'

interface Props {
  /** Mirrors the textarea path's Escape handler: clears text, attachments, skills, mention query. */
  onEscape: () => void
}

/** Escape clears the composer - same UX as MessageInput.tsx's textarea handleKeyDown('Escape'). */
export function EscapeClearPlugin({ onEscape }: Props): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        onEscape()
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
  }, [editor, onEscape])

  return null
}
