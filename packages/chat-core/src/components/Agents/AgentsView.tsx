// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState, useMemo } from 'react'
import { useChatStore } from '../../store/chatStore.js'
import { fetchAgentDetailsCached, type AgentEntry } from '../../api/agents.js'
import { InfoIcon } from '../Chat/composer/icons.js'

interface Props {
  snowflakeToken: string
  onOpenPanel?: () => void
}

export function AgentsView({ snowflakeToken, onOpenPanel }: Props) {
  const { agents, setActiveAgent, newThread, setActiveView, selectAgentDetails } = useChatStore()
  const [query, setQuery] = useState('')
  const [sortAz, setSortAz] = useState(false)
  const [loadingFqn, setLoadingFqn] = useState<string | null>(null)
  const [errorFqn, setErrorFqn] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let result = q
      ? agents.filter(
          (a) =>
            a.displayName.toLowerCase().includes(q) ||
            (a.description ?? '').toLowerCase().includes(q),
        )
      : [...agents]
    if (sortAz) result = result.slice().sort((a, b) => a.displayName.localeCompare(b.displayName))
    return result
  }, [agents, query, sortAz])

  function handleSelect(fqn: string) {
    setActiveAgent(fqn)
    if (!useChatStore.getState().activeThreadTempId) newThread(fqn)
    setActiveView('chat')
  }

  async function handleInfo(agent: AgentEntry) {
    setErrorFqn(null)
    setLoadingFqn(agent.fqn)
    const details = await fetchAgentDetailsCached(snowflakeToken, agent.fqn)
    setLoadingFqn((cur) => (cur === agent.fqn ? null : cur))
    if (!details) { setErrorFqn(agent.fqn); return }
    selectAgentDetails(details, agent.displayName)
    onOpenPanel?.()
  }

  return (
    <div className="agents-view">
      <div className="agents-toolbar">
        <input
          className="agents-search"
          type="search"
          placeholder="Filter agents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter agents"
        />
        <button
          className={`ctrl-btn${sortAz ? ' ctrl-btn--on' : ''}`}
          onClick={() => setSortAz((v) => !v)}
          title="Sort A–Z"
        >
          A–Z
        </button>
      </div>

      {filtered.length === 0 && (
        <div className="agents-empty">No agents found.</div>
      )}

      <div className="agents-grid">
        {filtered.map((agent) => (
          <div key={agent.fqn} className="agent-card">
            <button
              className="agent-card-main"
              onClick={() => handleSelect(agent.fqn)}
              title={agent.fqn}
            >
              <div className="agent-card-name">{agent.displayName}</div>
              {agent.description && (
                <div className="agent-card-desc">{agent.description}</div>
              )}
            </button>
            <button
              className="agent-card-info"
              aria-label="View agent details"
              title="View details"
              disabled={loadingFqn === agent.fqn}
              onClick={() => handleInfo(agent)}
            >
              {loadingFqn === agent.fqn ? <span className="spinner">⟳</span> : <InfoIcon />}
            </button>
            {errorFqn === agent.fqn && (
              <span className="agent-card-info-error">Couldn't load details</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

