// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useChatStore } from '../../../store/chatStore.js'
import { GraduationCapIcon } from './icons.js'

/**
 * Footer-right toggle for extended thinking, replacing the "Think deeper" button that used to
 * live in ChatControls.tsx. Same store field/action - only which component calls it moved.
 * The label hides under a narrow-viewport CSS media query (see index.css in both hosts) rather
 * than a JS breakpoint hook, matching how this codebase already handles responsive chrome.
 */
export function ThinkingToggle() {
  const extendedThinking = useChatStore((s) => s.extendedThinking)
  const toggleExtendedThinking = useChatStore((s) => s.toggleExtendedThinking)

  return (
    <button
      type="button"
      className={`thinking-toggle${extendedThinking ? ' thinking-toggle--on' : ''}`}
      onClick={toggleExtendedThinking}
      title="Extended thinking — agent reasons more deeply before responding"
      aria-pressed={extendedThinking}
    >
      <GraduationCapIcon />
      <span className="thinking-toggle-label">Extended thinking</span>
    </button>
  )
}
