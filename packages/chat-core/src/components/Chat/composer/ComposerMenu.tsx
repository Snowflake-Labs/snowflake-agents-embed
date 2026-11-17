// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react'
import type { AgentSkillInfo, AgentToolInfo } from '../../../api/agents.js'
import { fetchAgentDetailsCached } from '../../../api/agents.js'
import { fetchMcpConnections, invalidateMcpConnectionsCache, type McpConnection } from '../../../api/mcpConnections.js'
import { openMcpAuthorizationUrl } from '../../../api/mcpOAuth.js'
import type { FileAttachment } from '../../../types.js'
import { useFileAttachments } from '../../../hooks/useFileAttachments.js'
import { useClickOutside } from '../../../hooks/useClickOutside.js'
import { useChatStore } from '../../../store/chatStore.js'
import { useFeatureFlags } from '../../../lib/featureFlags.js'
import { PaperclipIcon, TelescopeIcon, PuzzleIcon, GlobeIcon, ChevronRightIcon, PlusIcon, PlugIcon, CheckIcon } from './icons.js'

interface Props {
  onAddFile: (attachment: FileAttachment) => void
  snowflakeToken: string
  agentFqn?: string
  selectedSkills: AgentSkillInfo[]
  onAddSkill: (skill: AgentSkillInfo) => void
  onRemoveSkill: (name: string) => void
  disabled?: boolean
}

/**
 * Consolidates upload/deep-research/web-search/skills behind one "+" trigger, replacing
 * AttachmentBar's and SkillPicker's separate trigger buttons (their chip-rendering tails
 * stay put in MessageInput.tsx). Deep research and web search read/write store booleans
 * directly - same fields ChatControls' old button used - since that's already-shared
 * state, not new ownership.
 */
export function ComposerMenu({
  onAddFile, snowflakeToken, agentFqn, selectedSkills, onAddSkill, onRemoveSkill, disabled,
}: Props) {
  const flags = useFeatureFlags()
  const deepResearch = useChatStore((s) => s.deepResearch)
  const toggleDeepResearch = useChatStore((s) => s.toggleDeepResearch)
  const webSearch = useChatStore((s) => s.webSearch)
  const toggleWebSearch = useChatStore((s) => s.toggleWebSearch)

  const [open, setOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [connectorsOpen, setConnectorsOpen] = useState(false)
  const [skills, setSkills] = useState<AgentSkillInfo[]>([])
  const [tools, setTools] = useState<AgentToolInfo[]>([])
  const [mcpConnections, setMcpConnections] = useState<McpConnection[]>([])
  const [coworkUrl, setCoworkUrl] = useState('')
  const [skillsLoading, setSkillsLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const addFiles = useFileAttachments(onAddFile)

  useClickOutside(menuRef, () => { setOpen(false); setSkillsOpen(false); setConnectorsOpen(false) }, open)

  // Clears the previous agent's list the instant agentFqn changes, ahead of the fetch
  // below resolving - otherwise a switch made while the menu is already open renders
  // agent A's skills/tools under agent B's fqn until the new fetch lands. Also marks
  // loading optimistically when the menu is already open, so the switch shows
  // "Loading…" instead of a one-frame "No skills configured" flash before the fetch
  // below starts.
  useEffect(() => {
    setSkills([])
    setTools([])
    setMcpConnections([])
    if (open) setSkillsLoading(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentFqn])

  // Fetched as soon as the top-level "+" menu opens, not only when the Skills submenu
  // does - the Web search row's visibility depends on the agent's tool list too, and that
  // has to be known before the row can render at all (unlike Skills, whose row always
  // shows and only its contents are lazy).
  useEffect(() => {
    if (!open || !agentFqn) return
    let stale = false
    setSkillsLoading(true)
    void fetchAgentDetailsCached(snowflakeToken, agentFqn).then((details) => {
      // Guards against agent A's slow fetch resolving after the user has already
      // switched to agent B and clobbering B's freshly-fetched skills/tools.
      if (!stale) {
        setSkills(details?.skills ?? [])
        setTools(details?.tools ?? [])
      }
    }).finally(() => {
      if (!stale) setSkillsLoading(false)
    })
    fetchMcpConnections(snowflakeToken, agentFqn).then((conn) => {
      if (!stale) {
        setCoworkUrl(conn.coworkUrl)
        setMcpConnections(conn.servers)
      }
    }).catch(() => {})
    return () => { stale = true }
  }, [open, agentFqn, snowflakeToken])

  // Status is per-user and can change after a CoWork OAuth tab; drop the short TTL
  // and refetch when the window comes back.
  useEffect(() => {
    function onReturn() {
      if (document.visibilityState && document.visibilityState !== 'visible') return
      invalidateMcpConnectionsCache()
      if (!open || !agentFqn) return
      fetchMcpConnections(snowflakeToken, agentFqn).then((conn) => {
        setCoworkUrl(conn.coworkUrl)
        setMcpConnections(conn.servers)
      }).catch(() => {})
    }
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [open, agentFqn, snowflakeToken])

  async function handleFiles(files: FileList | null) {
    await addFiles(files)
    if (fileInputRef.current) fileInputRef.current.value = ''
    setOpen(false)
  }

  function toggleSkill(skill: AgentSkillInfo) {
    if (selectedSkills.some((s) => s.name === skill.name)) onRemoveSkill(skill.name)
    else onAddSkill(skill)
  }

  const skillsEnabled = flags.skills && Boolean(agentFqn)
  const webSearchEnabled = flags.webSearch && tools.some((t) => t.type === 'web_search')
  // The connections endpoint deliberately returns external OAuth connectors only,
  // matching native CoWork. Raw agent details also include Snowflake-managed MCP
  // servers, so falling back to that list would incorrectly expose them here.
  const listedMcp = mcpConnections
  const connectorsEnabled = Boolean(agentFqn) && listedMcp.length > 0
  const connectedCount = listedMcp.filter((s) => s.connected === true).length
  const statusKnown = listedMcp.length > 0 && listedMcp.every((s) => s.connected !== null)
  const connectorsCount = statusKnown ? `${connectedCount} of ${listedMcp.length}` : String(listedMcp.length)

  function openCowork() {
    if (coworkUrl.startsWith('https://')) openMcpAuthorizationUrl(coworkUrl)
  }

  // Computed from the flags actually gating each row below, rather than a fixed string
  // naming all four - with any subset flagged off, the tooltip previously kept promising
  // capabilities the menu didn't have.
  const enabledOptionLabels = [
    flags.fileUpload && 'Upload files',
    flags.deepResearch && 'Deep research',
    webSearchEnabled && 'Web search',
    skillsEnabled && 'Skills',
    connectorsEnabled && 'Connectors',
  ].filter((label): label is string => Boolean(label))
  const menuLabel = enabledOptionLabels.length ? enabledOptionLabels.join(', ') : 'No options available'

  return (
    <div className="composer-menu" ref={menuRef}>
      <button
        type="button"
        className="composer-menu-trigger"
        title={menuLabel}
        aria-label={menuLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => {
          if (o) { setSkillsOpen(false); setConnectorsOpen(false) }
          return !o
        })}
        aria-expanded={open}
      ><PlusIcon /></button>
      {open && (
        <ul className="composer-menu-list popover-surface">
          {enabledOptionLabels.length === 0 && (
            <li className="composer-menu-empty">No options available</li>
          )}
          {flags.fileUpload && (
            <li>
              <label className="composer-menu-item">
                <span className="composer-menu-icon-box"><PaperclipIcon size={20} /></span> Upload files
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.txt,.json,.md,text/plain,text/csv,application/json,text/markdown"
                  multiple
                  disabled={disabled}
                  style={{ display: 'none' }}
                  onChange={(e) => handleFiles(e.target.files)}
                />
              </label>
            </li>
          )}
          {flags.deepResearch && (
            <li>
              <button
                type="button"
                className="composer-menu-item"
                role="switch"
                aria-checked={deepResearch}
                onClick={() => { toggleDeepResearch(); setOpen(false) }}
                title="Deep research — agent runs extended tool chains"
              >
                <span className="composer-menu-icon-box"><TelescopeIcon size={20} /></span> Deep Research
                <span className={`composer-menu-switch${deepResearch ? ' composer-menu-switch--on' : ''}`}>
                  <span className="composer-menu-switch-thumb" />
                </span>
              </button>
            </li>
          )}
          {webSearchEnabled && (
            <li>
              <button
                type="button"
                className="composer-menu-item"
                role="switch"
                aria-checked={webSearch}
                onClick={() => { toggleWebSearch(); setOpen(false) }}
                title="Web search — let the agent search the public web"
              >
                <span className="composer-menu-icon-box"><GlobeIcon size={20} /></span> Web search
                <span className={`composer-menu-switch${webSearch ? ' composer-menu-switch--on' : ''}`}>
                  <span className="composer-menu-switch-thumb" />
                </span>
              </button>
            </li>
          )}
          {skillsEnabled && (
            <li className="skills-submenu">
              <button
                type="button"
                className="composer-menu-item"
                onClick={() => { setConnectorsOpen(false); setSkillsOpen((o) => !o) }}
                aria-expanded={skillsOpen}
              >
                <span className="composer-menu-icon-box"><PuzzleIcon size={20} /></span> Skills
                {selectedSkills.length > 0 && <span className="composer-menu-badge">{selectedSkills.length}</span>}
                <ChevronRightIcon className="composer-menu-chevron" />
              </button>
              {skillsOpen && (
                <ul className="skills-submenu-list popover-surface">
                  {skillsLoading && <li className="skills-submenu-loading">Loading…</li>}
                  {!skillsLoading && skills.length === 0 && <li className="skills-submenu-empty">No skills configured on this agent.</li>}
                  {skills.map((s) => {
                    const isSelected = selectedSkills.some((sel) => sel.name === s.name)
                    return (
                      <li key={s.name}>
                        <button
                          type="button"
                          className={`skills-submenu-item${isSelected ? ' skills-submenu-item--selected' : ''}`}
                          onClick={() => toggleSkill(s)}
                        >
                          {s.name}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )}
          {connectorsEnabled && (
            <li className="skills-submenu">
              <button
                type="button"
                className="composer-menu-item"
                onClick={() => { setSkillsOpen(false); setConnectorsOpen((o) => !o) }}
                aria-expanded={connectorsOpen}
              >
                <span className="composer-menu-icon-box"><PlugIcon size={20} /></span> Connectors
                <span className="composer-menu-count">{connectorsCount}</span>
                <ChevronRightIcon className="composer-menu-chevron" />
              </button>
              {connectorsOpen && (
                <ul className="skills-submenu-list connectors-submenu-list popover-surface">
                  {listedMcp.map((s) => {
                    const connected = s.connected === true
                    const knownDisconnected = s.connected === false
                    return (
                      <li key={s.fqn}>
                        <button
                          type="button"
                          className={`connectors-submenu-item${connected ? ' connectors-submenu-item--static' : ''}`}
                          title={connected
                            ? undefined
                            : 'Opens Snowflake CoWork to connect this connector.'}
                          onClick={() => { if (!connected) openCowork() }}
                        >
                          <span className="connectors-submenu-name">{s.displayName}</span>
                          {connected && <CheckIcon className="connectors-submenu-check" size={16} />}
                          {knownDisconnected && <span className="connectors-submenu-connect">Connect</span>}
                        </button>
                      </li>
                    )
                  })}
                  <li>
                    <button type="button" className="connectors-submenu-manage" onClick={openCowork}>
                      Manage Connectors
                    </button>
                  </li>
                </ul>
              )}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
