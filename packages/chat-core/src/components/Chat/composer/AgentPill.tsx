// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react'
import { useChatStore } from '../../../store/chatStore.js'
import { useClickOutside } from '../../../hooks/useClickOutside.js'
import { ChevronDownIcon } from './icons.js'

/**
 * Toolbar-scoped replacement for the sidebar <select> (AgentPicker, removed in the same
 * change) - a truncating pill visible at every breakpoint instead of a selector only the
 * sidebar rail has room for. Deliberately not a refactor of AgentPicker in place: no shared
 * markup (native <select>/<option> vs. a popover), no shared test surface
 * (AgentPicker.test.tsx pins role="combobox"/role="option"), and this needs scoped
 * selectors rather than AgentPicker's whole-store destructure, which re-renders on every
 * store write - tolerable in a sidebar, wrong in the composer.
 */
export function AgentPill() {
  const agents = useChatStore((s) => s.agents)
  const activeAgentFqn = useChatStore((s) => s.activeAgentFqn)
  const setActiveAgent = useChatStore((s) => s.setActiveAgent)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useClickOutside(wrapRef, () => setOpen(false), open)

  if (agents.length === 0) return null

  const active = agents.find((a) => a.fqn === activeAgentFqn)
  const label = active?.displayName ?? 'Select agent'

  return (
    <div className="agent-pill-wrap" ref={wrapRef}>
      <button
        type="button"
        className="agent-pill"
        title={label}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="agent-pill-label">{label}</span>
        <ChevronDownIcon className="agent-pill-chevron" />
      </button>
      {open && (
        <ul className="agent-pill-list popover-surface" role="listbox">
          <li className="agent-pill-section-header">Agents</li>
          {agents.map((a) => (
            <li key={a.fqn}>
              <button
                type="button"
                role="option"
                aria-selected={a.fqn === activeAgentFqn}
                className={`agent-pill-item${a.fqn === activeAgentFqn ? ' agent-pill-item--active' : ''}`}
                onClick={() => { setActiveAgent(a.fqn); setOpen(false) }}
              >
                <span className="agent-pill-item-name">{a.displayName}</span>
                {a.description && <span className="agent-pill-item-desc">{a.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
