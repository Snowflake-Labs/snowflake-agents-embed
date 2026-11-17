// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useEffect } from 'react'

interface Props {
  editable: boolean
}

/** Keeps the editor's editable state in sync with the `disabled` prop after mount. */
export function EditablePlugin({ editable }: Props): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    editor.setEditable(editable)
  }, [editor, editable])

  return null
}
