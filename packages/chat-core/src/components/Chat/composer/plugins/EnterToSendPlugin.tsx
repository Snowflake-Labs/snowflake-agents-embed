// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from 'lexical'
import { useEffect } from 'react'

interface Props {
  onSubmit: () => void
  disabled: boolean
  /** Suppresses submit while the @-mention dropdown is open, so Enter picks a match instead. */
  isMenuOpen: boolean
}

export function EnterToSendPlugin({ onSubmit, disabled, isMenuOpen }: Props): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event) return false
        if (disabled) return false
        if (isMenuOpen) return true

        // MDN recommends keyCode 229 as a fallback even though it's deprecated - CJK IME
        // composition dispatches a plain Enter to commit the candidate, not to submit.
        const isComposing = Boolean(event.isComposing) || event.keyCode === 229
        if (isComposing) return false
        if (event.shiftKey) return false

        event.preventDefault()
        onSubmit()
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
  }, [editor, onSubmit, disabled, isMenuOpen])

  return null
}
