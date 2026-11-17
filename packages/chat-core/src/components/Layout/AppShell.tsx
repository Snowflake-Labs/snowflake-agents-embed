// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, useCallback } from 'react'
import { ChatContainer } from '../Chat/ChatContainer.js'
import { AgentsView } from '../Agents/AgentsView.js'
import { SearchView } from '../Search/SearchView.js'
import { SideNav } from './SideNav.js'
import { Drawer } from './Drawer.js'
import { RightPanel } from './RightPanel.js'
import type { RightPanelContent } from './RightPanel.js'
import { useChatStore } from '../../store/chatStore.js'
import { useBreakpoint } from '../../hooks/useBreakpoint.js'
import { useOpenThread } from '../../hooks/useOpenThread.js'
import { fetchAgents } from '../../api/agents.js'
import { getHostAdapter } from '../../host/hostAdapter.js'
import { getDefaultAgentFqn, loadFeatureFlags } from '../../lib/featureFlags.js'
import { ThemeProvider } from '../../lib/themeContext.js'
import { uniqueTurnWarnings, type TurnWarning } from '../../lib/turn-warning.js'
import { MenuIcon, SpinnerIcon } from '../Chat/composer/icons.js'
import type { HostShellAdapter } from '../../host/hostShellAdapter.js'

const SIDEBAR_COLLAPSED_KEY = 'agents_sidebar_collapsed'
const EMPTY_WARNINGS: TurnWarning[] = []

interface Props {
  /** Supplies everything host-specific: auth, theme source, persist/resize/nav effects,
   * the record-context preamble (ui only), and the ShareButton component to render. */
  adapter: HostShellAdapter
  initialAgentFqn?: string
  openThreadId?: number
}

export function AppShell({ adapter, initialAgentFqn, openThreadId }: Props) {
  // `ready` replaces a plain "is there a token" gate. Some hosts (ui) hold no Snowflake
  // credential in the browser at all — the relay uses its own service identity — so a
  // truthy-token check would never pass there and nothing would ever bootstrap.
  const {
    ready,
    token: snowflakeToken,
    error: hostError,
    loading,
    defaultAgentFqn,
    openThreadId: hostThreadId,
    currentUserName,
    onRetry,
  } = adapter.useAuth()
  const theme = adapter.useTheme()
  // Scoped subscriptions rather than `useChatStore()`. AppShell renders the whole shell - rail,
  // sidebar, right panel - and an unscoped subscription re-rendered all of it on every streamed
  // text delta, because those deltas land in `openThreads`. Nothing here needs a turn's text;
  // the scalars below plus the latest assistant warnings *array identity* (stable across text
  // deltas) are all the shell reads off the active thread.
  const activeThreadTempId = useChatStore((s) => s.activeThreadTempId)
  const activeThreadId = useChatStore((s) => (s.activeThreadTempId ? s.openThreads[s.activeThreadTempId]?.threadId : undefined))
  const activeThreadAgentFqn = useChatStore((s) => (s.activeThreadTempId ? s.openThreads[s.activeThreadTempId]?.agentFqn : undefined))
  const lastAssistantMessageId = useChatStore((s) => (s.activeThreadTempId ? s.openThreads[s.activeThreadTempId]?.thread?.lastAssistantMessageId : undefined))
  const latestTurnWarnings = useChatStore((s) => {
    const t = s.activeThreadTempId ? s.openThreads[s.activeThreadTempId] : undefined
    if (!t) return EMPTY_WARNINGS
    for (let i = t.turns.length - 1; i >= 0; i--) {
      if (t.turns[i].role === 'assistant') return t.turns[i].warnings ?? EMPTY_WARNINGS
    }
    return EMPTY_WARNINGS
  })
  const activeView = useChatStore((s) => s.activeView)
  const agents = useChatStore((s) => s.agents)
  const activeAgentFqn = useChatStore((s) => s.activeAgentFqn)
  const selectedArtifact = useChatStore((s) => s.selectedArtifact)
  const selectedCitations = useChatStore((s) => s.selectedCitations)
  const selectedAgentDetails = useChatStore((s) => s.selectedAgentDetails)
  const selectedAgentDetailsName = useChatStore((s) => s.selectedAgentDetailsName)
  // Actions - stable identities, so these never cause a render.
  const setAgents = useChatStore((s) => s.setAgents)
  const setActiveAgent = useChatStore((s) => s.setActiveAgent)
  const newThread = useChatStore((s) => s.newThread)
  const setActiveView = useChatStore((s) => s.setActiveView)
  const selectArtifact = useChatStore((s) => s.selectArtifact)
  const selectCitations = useChatStore((s) => s.selectCitations)
  const selectAgentDetails = useChatStore((s) => s.selectAgentDetails)
  const { bp, ref: shellRef } = useBreakpoint()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // localStorage, not the store's sessionStorage: a rail preference should outlive the tab.
  // Guarded - a restricted iframe can throw on access.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1' } catch { return false }
  })
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const bootstrapped = useRef(false)
  const openThread = useOpenThread(snowflakeToken ?? '')

  // Tell the host which thread is live, so a host-side surface (e.g. ui's utility bar) can
  // resume it after navigation destroys this page. Read off the active open thread rather
  // than tracked separately - `thread.lastAssistantMessageId` is the same value the next
  // turn sends as parent_message_id, so persisting it keeps a restored conversation on the
  // same branch. A no-op for hosts that don't need it (tab).
  adapter.useShellEffects({
    ready,
    activeThreadId,
    lastAssistantMessageId,
    agentFqn: activeThreadAgentFqn,
  })

  // Bootstrap: load agents and create initial thread (once the host session lands)
  useEffect(() => {
    if (!ready || bootstrapped.current) return
    bootstrapped.current = true

    void (async () => {
      // Await config so hosts see DEFAULT_AGENT_FQN before the picker
      // falls through to the first SHOW AGENTS row. A host-supplied defaultAgentFqn
      // still wins over the /api/config value.
      await loadFeatureFlags(getHostAdapter().baseUrl(), snowflakeToken ?? '')
      const orgDefault = defaultAgentFqn || getDefaultAgentFqn() || undefined

      try {
        const agents = await fetchAgents(snowflakeToken ?? '')
        setAgentsError(null)
        setAgents(agents)
        // Precedence: an explicit prop (URL / host pin), then the last agent this
        // tab already chose (sessionStorage), then the org default from the host
        // or GET /api/config, then whatever SHOW AGENTS put first. Persist is a
        // last-selected hint — without this check bootstrap overwrote it with the
        // org default on every load and EmptyState fetched starters for the wrong
        // agent first.
        const persisted = useChatStore.getState().activeAgentFqn
        const persistedOk = Boolean(persisted && agents.some((a) => a.fqn === persisted))
        const fqn = initialAgentFqn ?? (persistedOk ? persisted : undefined) ?? orgDefault ?? agents[0]?.fqn ?? ''
        setActiveAgent(fqn)
        if (!useChatStore.getState().activeThreadTempId) {
          newThread(fqn)
        }
      } catch (err: unknown) {
        setAgentsError(err instanceof Error ? err.message : 'Failed to load agents')
        if (!useChatStore.getState().activeThreadTempId) {
          const persisted = useChatStore.getState().activeAgentFqn
          newThread(initialAgentFqn ?? (persisted || undefined) ?? orgDefault ?? '')
        }
      }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // Deep-link: open the specified thread and switch to chat view (via shared useOpenThread
  // hook). The id can arrive either as a prop or on the host session (a host may read a
  // URL parameter from the parent page, since the iframe never sees the parent's query string).
  // Guarded by a ref (not just the dependency array) because `openThread` itself changes
  // `activeThreadTempId` (via `newThread`/`activateThread`) while it's still resolving -
  // without the ref, that state change would re-run this effect and call `openThread` again
  // for the same id, compounding into an unbounded loop of thread creation + refetches.
  const threadToOpen = openThreadId ?? hostThreadId
  const openedThreadRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!threadToOpen || !ready || !activeThreadTempId) return
    if (openedThreadRef.current === threadToOpen) return
    openedThreadRef.current = threadToOpen
    void openThread(threadToOpen)
  }, [threadToOpen, ready, activeThreadTempId, openThread])

  // Close drawers when breakpoint widens
  useEffect(() => {
    if (bp !== 'narrow') setSidebarOpen(false)
    if (bp === 'wide') setRightPanelOpen(false)
  }, [bp])

  const handleNewChat = useCallback(() => {
    newThread(useChatStore.getState().activeAgentFqn)
    setActiveView('chat')
    setSidebarOpen(false)
  }, [newThread, setActiveView])

  const handleToggleCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0') } catch { /* restricted iframe */ }
      return next
    })
  }, [])

  const handleArtifactOpen = useCallback(() => {
    if (bp !== 'wide') setRightPanelOpen(true)
  }, [bp])

  if (loading) return (
    <div className="loading">
      <span className="loading-row">
        <SpinnerIcon className="spinner" size={16} />
        Connecting...
      </span>
    </div>
  )
  if (hostError) return (
    <div className="auth-error">
      <p>Could not connect: {hostError}</p>
      <p>Contact your Snowflake admin if this persists.</p>
      {onRetry && <button onClick={onRetry}>Try again</button>}
    </div>
  )

  const sidebarContent = ready
    ? (
      <SideNav
        snowflakeToken={snowflakeToken ?? ''}
        connected={ready}
        onNewChat={handleNewChat}
        userName={currentUserName}
        showUnmappedHistory={adapter.perUserHistory === true}
        collapsed={bp !== 'narrow' ? sidebarCollapsed : undefined}
        onToggleCollapsed={bp !== 'narrow' ? handleToggleCollapsed : undefined}
      />
    )
    : null


  return (
    <ThemeProvider theme={theme}>
    <div className="app-shell" data-bp={bp} ref={shellRef as React.RefObject<HTMLDivElement>}>
      {agentsError && (
        <div className="fetch-error-banner fetch-error-banner--overlay">
          <span>{agentsError}</span>
          <button className="fetch-error-dismiss" onClick={() => setAgentsError(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* Sidebar as drawer (narrow breakpoint only) */}
      {bp === 'narrow' && (
        <Drawer open={sidebarOpen} side="left" onClose={() => setSidebarOpen(false)}>
          {sidebarContent}
        </Drawer>
      )}

      {/* Sidebar persistent (mid + wide) */}
      {bp !== 'narrow' && (
        <aside className="sidebar" data-collapsed={sidebarCollapsed}>
          {sidebarContent}
        </aside>
      )}

      {/* Main view area */}
      <div className="view-container">
        {bp === 'narrow' && (
          <div className="panel-btns">
            <button className="panel-btn" onClick={() => setSidebarOpen(true)}><MenuIcon /> History</button>
            {selectedArtifact && (
              <button className="panel-btn panel-btn--right" onClick={handleArtifactOpen}>
                ◫ Artifact
              </button>
            )}
          </div>
        )}

        {/* hidden, not unmounted, so switching to Agents/Search and back keeps scroll
            position and any in-flight stream. Needs its own flex sizing - a plain block div
            here doesn't shrink to .view-container's available height, so it grows to fit the
            full conversation and everything below the fold (including the composer) gets
            clipped by .view-container's overflow:hidden instead of scrolling. */}
        <div className="chat-view-slot" hidden={activeView !== 'chat'}>
          <ChatContainer
            snowflakeToken={snowflakeToken ?? ''}
            connected={ready}
            ShareButton={adapter.ShareButton}
            buildContextPreamble={adapter.buildContextPreamble}
            currentUserName={currentUserName}
            onArtifactOpen={handleArtifactOpen}
          />
        </div>
        {activeView === 'agents' && (
          <AgentsView snowflakeToken={snowflakeToken ?? ''} onOpenPanel={handleArtifactOpen} />
        )}
        {activeView === 'search' && ready && (
          <SearchView snowflakeToken={snowflakeToken ?? ''} />
        )}
      </div>

      {/* Right panel: persistent at wide, drawer at mid/narrow. Artifact, citations, and agent
          details are mutually exclusive - whichever was most recently selected wins. */}
      {(() => {
        const rightPanelContent: RightPanelContent | null = selectedArtifact
          ? { kind: 'artifact', artifact: selectedArtifact }
          : selectedCitations
            ? { kind: 'citations', citations: selectedCitations }
            : selectedAgentDetails
              ? {
                  kind: 'agent-details' as const,
                  details: selectedAgentDetails,
                  agentName: selectedAgentDetailsName ?? agents.find((a) => a.fqn === activeAgentFqn)?.displayName,
                  agentFqn: activeAgentFqn,
                  warnings: activeView === 'chat' ? uniqueTurnWarnings(latestTurnWarnings) : EMPTY_WARNINGS,
                }
              : null
        if (!rightPanelContent) return null
        const closePanel = () => { selectArtifact(null); selectCitations(null); selectAgentDetails(null) }
        return bp === 'wide' ? (
          <RightPanel content={rightPanelContent} snowflakeToken={snowflakeToken ?? ''} onClose={closePanel} />
        ) : (
          <Drawer open={rightPanelOpen} side="right" onClose={() => setRightPanelOpen(false)}>
            <RightPanel content={rightPanelContent} snowflakeToken={snowflakeToken ?? ''} onClose={() => { closePanel(); setRightPanelOpen(false) }} />
          </Drawer>
        )
      })()}
    </div>
    </ThemeProvider>
  )
}
