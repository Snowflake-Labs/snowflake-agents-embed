// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useChatStore } from '../../../store/chatStore.js'
import { TelescopeIcon, XIcon } from './icons.js'

/**
 * Visual-only restyle of the deep-research indicator: a dismissible chip showing the same
 * `deepResearch` boolean the "+" menu's toggle row controls (see ComposerMenu.tsx). No new
 * progress/phase UI - Cortex doesn't emit research-phase SSE events, so ThinkingSteps.tsx is
 * unchanged.
 */
export function DeepResearchChip() {
  const deepResearch = useChatStore((s) => s.deepResearch)
  const toggleDeepResearch = useChatStore((s) => s.toggleDeepResearch)

  if (!deepResearch) return null

  return (
    <span className="deep-research-chip">
      <TelescopeIcon />
      <span className="deep-research-chip-label">Research</span>
      <button
        type="button"
        className="deep-research-chip-remove"
        onClick={toggleDeepResearch}
        title="Turn off deep research"
      ><XIcon /></button>
    </span>
  )
}
