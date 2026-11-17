// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { COMMAND_PRIORITY_HIGH, PASTE_COMMAND } from 'lexical'
import { useEffect } from 'react'

interface Props {
  onPasteFiles: ((files: FileList) => void) | undefined
}

/**
 * Extracts pasted files and delegates to the same addFiles() path the click-to-upload input
 * and drag-drop use (see useFileAttachments.ts) - mirrors handlePaste() on the textarea path.
 * Falls through to Lexical's own PASTE_COMMAND handler for plain text.
 */
export function PasteFilesPlugin({ onPasteFiles }: Props): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!('clipboardData' in event) || !event.clipboardData) return false
        const files = event.clipboardData.files
        if (!onPasteFiles || !files || files.length === 0) return false
        event.preventDefault()
        onPasteFiles(files)
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
  }, [editor, onPasteFiles])

  return null
}
