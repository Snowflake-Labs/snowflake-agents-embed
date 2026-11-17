// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useLayoutEffect } from 'react'

// Matches the textarea path's single-line rows={1} start; grows up to a fixed cap rather
// than the unbounded scroll a bare textarea would need manual CSS for.
// 30px = one line-height at the composer's 16px/30px type size; a smaller value clips
// line one because this inline style beats the stylesheet.
const MIN_HEIGHT_PX = 30
const MAX_HEIGHT_PX = 210

/** Auto-grows the contenteditable root as content wraps - the plain textarea is fixed at rows={1}. */
export function AutoResizePlugin(): null {
  const [editor] = useLexicalComposerContext()

  useLayoutEffect(() => {
    const rootElement = editor.getRootElement()
    if (!rootElement) return

    const resize = () => {
      rootElement.style.height = '0px'
      const contentHeight = rootElement.scrollHeight
      rootElement.style.height = `${Math.max(MIN_HEIGHT_PX, Math.min(contentHeight, MAX_HEIGHT_PX))}px`
    }

    resize()
    const unregister = editor.registerUpdateListener(() => resize())
    return () => unregister()
  }, [editor])

  return null
}
