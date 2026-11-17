// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from 'react'
import type { Artifact, Citation } from '../../types.js'
import type { AgentDetails } from '../../api/agents.js'
import { ChartArtifact } from '../Artifact/ChartArtifact.js'
import { TableArtifact } from '../Artifact/TableArtifact.js'
import { MapArtifact } from '../Artifact/MapArtifact.js'
import { fetchFullTableResult } from '../../api/statements.js'
import { WarningIcon } from '../Chat/composer/icons.js'
import { fetchMcpConnections, type McpConnection } from '../../api/mcpConnections.js'
import { openMcpAuthorizationUrl } from '../../api/mcpOAuth.js'
import { ApiError } from '../../api/apiError.js'
import {
  formatTurnWarning,
  isMcpTurnWarning,
  type TurnWarning,
} from '../../lib/turn-warning.js'

export type RightPanelContent =
  | { kind: 'artifact'; artifact: Artifact }
  | { kind: 'citations'; citations: Citation[] }
  | {
      kind: 'agent-details'
      details: AgentDetails
      agentName?: string
      agentFqn?: string
      warnings?: TurnWarning[]
    }

function truncate(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

interface Props {
  content: RightPanelContent
  snowflakeToken: string
  onClose: () => void
}

export function RightPanel({ content, snowflakeToken, onClose }: Props) {
  const [fullData, setFullData] = useState<unknown[][] | null>(null)
  const [loadingFull, setLoadingFull] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const artifactId = content.kind === 'artifact' ? content.artifact.id : null
  // A newly selected artifact invalidates any full-result fetch made for the previous one.
  useEffect(() => {
    setFullData(null)
    setLoadingFull(false)
    setLoadError(null)
  }, [artifactId])

  function loadFullResults(queryId: string) {
    setLoadingFull(true)
    setLoadError(null)
    fetchFullTableResult(snowflakeToken, queryId)
      .then((rows) => setFullData(rows))
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to load full results'))
      .finally(() => setLoadingFull(false))
  }

  return (
    <div className="right-panel">
      <div className="right-panel-header">
        <span className="right-panel-title">
          {content.kind === 'citations'
            ? 'Sources'
            : content.kind === 'agent-details'
              ? 'Agent details'
              : content.artifact.type === 'chart' ? 'Chart'
                : content.artifact.type === 'map' ? 'Map' : 'Table'}
        </span>
        <button className="right-panel-close" onClick={onClose} title="Close" aria-label="Close">✕</button>
      </div>
      <div className="right-panel-body">
        {content.kind === 'artifact' && content.artifact.type === 'chart' && (
          <ChartArtifact spec={content.artifact.spec as any} />
        )}
        {content.kind === 'artifact' && content.artifact.type === 'map' && (
          <MapArtifact spec={content.artifact.spec} />
        )}
        {content.kind === 'artifact' && content.artifact.type === 'table' && (() => {
          const table = content.artifact
          const rows = fullData ?? table.data
          const truncated = table.queryId !== undefined && table.numRows !== undefined && table.numRows > rows.length
          return (
            <>
              <TableArtifact rowType={table.rowType} data={rows} numRows={table.numRows} title={table.title} />
              {truncated && (
                <div className="load-full-results">
                  <button onClick={() => loadFullResults(table.queryId!)} disabled={loadingFull}>
                    {loadingFull ? 'Loading…' : 'Load full results'}
                  </button>
                  {loadError && (
                    <div className="load-full-results-error">
                      <WarningIcon className="warning-icon" size={14} />
                      <span>{loadError}</span>
                      <button onClick={() => loadFullResults(table.queryId!)}>Retry</button>
                    </div>
                  )}
                </div>
              )}
            </>
          )
        })()}
        {content.kind === 'citations' && (
          <ul className="citations-panel-list">
            {content.citations.map((c) => (
              <li key={c.searchResultId ?? `${c.contentIndex ?? 0}:${c.index}`} className="citations-panel-item">
                <span className="citations-panel-index">{c.index}</span>
                {(c.docTitle ?? c.docId) && <div className="citation-title">{c.docTitle ?? c.docId}</div>}
                {c.text && <p className="citations-panel-snippet" title={c.text}>{truncate(c.text)}</p>}
                {c.url && (
                  <a href={c.url} target="_blank" rel="noopener noreferrer" className="citation-link">
                    Open source ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        {content.kind === 'agent-details' && (
          <div className="agent-details-panel">
            {content.agentName && <h3 className="agent-details-name">{content.agentName}</h3>}
            {(content.warnings?.length ?? 0) > 0 && (
              <AgentDetailsWarnings
                warnings={content.warnings!}
                snowflakeToken={snowflakeToken}
                agentFqn={content.agentFqn}
              />
            )}
            {content.details.orchestrationModel && (
              <div className="agent-details-field">
                <div className="agent-details-label">Orchestration model</div>
                <div className="agent-details-value">{content.details.orchestrationModel}</div>
              </div>
            )}
            {content.details.responseInstructions && (
              <div className="agent-details-field">
                <div className="agent-details-label">Response instructions</div>
                <div className="agent-details-value">{content.details.responseInstructions}</div>
              </div>
            )}
            {content.details.orchestrationInstructions && (
              <div className="agent-details-field">
                <div className="agent-details-label">Orchestration instructions</div>
                <div className="agent-details-value">{content.details.orchestrationInstructions}</div>
              </div>
            )}
            {content.details.tools.length > 0 && (
              <div className="agent-details-field">
                <div className="agent-details-label">Tools</div>
                <ul className="agent-details-tool-list">
                  {content.details.tools.map((t, i) => (
                    <li key={i}>
                      <strong>{t.name ?? t.type ?? 'Tool'}</strong>
                      {t.type && t.name && <span className="agent-details-tool-type"> ({t.type})</span>}
                      {t.description && <div className="agent-details-tool-desc">{t.description}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {content.details.dataSources.length > 0 && (
              <div className="agent-details-field">
                <div className="agent-details-label">Data sources</div>
                <ul className="agent-details-datasource-list">
                  {content.details.dataSources.map((d, i) => (
                    <li key={i}>
                      <strong>{d.toolName}</strong>
                      {d.warehouse && <span> · warehouse {d.warehouse}</span>}
                      {d.semanticModelFile && <div className="agent-details-semantic-model">{d.semanticModelFile}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {content.details.skills.length > 0 && (
              <div className="agent-details-field">
                <div className="agent-details-label">Skills</div>
                <ul className="agent-details-skill-list">
                  {content.details.skills.map((s, i) => (
                    <li key={i}>
                      <strong>{s.name}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!content.details.orchestrationModel && !content.details.responseInstructions &&
              !content.details.orchestrationInstructions && content.details.tools.length === 0 &&
              content.details.dataSources.length === 0 && content.details.skills.length === 0 &&
              !(content.warnings?.length) && (
                <div className="agent-details-empty">No details available for this agent.</div>
              )}
          </div>
        )}
      </div>
    </div>
  )
}

function AgentDetailsWarnings({
  warnings,
  snowflakeToken,
  agentFqn,
}: {
  warnings: TurnWarning[]
  snowflakeToken: string
  agentFqn?: string
}) {
  const hasMcp = warnings.some(isMcpTurnWarning)
  const [connections, setConnections] = useState<McpConnection[]>([])
  const [coworkUrl, setCoworkUrl] = useState('')
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!hasMcp || !snowflakeToken || !agentFqn) return
    let stale = false
    fetchMcpConnections(snowflakeToken, agentFqn)
      .then((conn) => {
        if (stale) return
        setCoworkUrl(conn.coworkUrl)
        setConnections(conn.servers)
      })
      .catch(() => {})
    return () => { stale = true }
  }, [hasMcp, snowflakeToken, agentFqn])

  const lines = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const w of warnings) {
      const line = formatTurnWarning(w, connections)
      if (seen.has(line)) continue
      seen.add(line)
      out.push(line)
    }
    return out
  }, [warnings, connections])

  async function onOpenCowork() {
    setError(null)
    if (coworkUrl.startsWith('https://')) {
      openMcpAuthorizationUrl(coworkUrl)
      return
    }
    if (!agentFqn || !snowflakeToken) {
      setError('Could not open Snowflake CoWork.')
      return
    }
    setOpening(true)
    try {
      const conn = await fetchMcpConnections(snowflakeToken, agentFqn)
      if (conn.coworkUrl.startsWith('https://')) {
        setCoworkUrl(conn.coworkUrl)
        setConnections(conn.servers)
        openMcpAuthorizationUrl(conn.coworkUrl)
      } else {
        setError('Could not open Snowflake CoWork.')
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open Snowflake CoWork.')
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="agent-details-field">
      <div className="agent-details-label">{hasMcp ? 'Connectors' : 'Warnings'}</div>
      <ul className="agent-details-warnings">
        {lines.map((line) => (
          <li key={line} className="agent-details-warning">
            <WarningIcon className="warning-icon" size={14} />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      {hasMcp && (
        <button
          type="button"
          className="action-btn"
          onClick={() => void onOpenCowork()}
          disabled={opening}
        >
          {opening ? 'Opening…' : 'Open CoWork'}
        </button>
      )}
      {error && <div className="agent-details-warning-error">{error}</div>}
    </div>
  )
}

