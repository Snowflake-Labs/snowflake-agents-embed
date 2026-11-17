// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import { throttledSessionStorage } from './throttledStorage.js'
import type { ConversationTurn, ThreadState, Artifact, Citation } from '../types.js'
import type { AgentEntry, AgentDetails } from '../api/agents.js'
import type { ThreadSummary } from '../api/threads.js'

export interface OpenThread {
  threadId?: number          // undefined until Cortex assigns one
  tempId: string             // stable client key before threadId is known
  agentFqn: string
  turns: ConversationTurn[]
  thread: ThreadState
  isStreaming: boolean
  /** In-progress composer text for this thread, so switching threads or a reload doesn't lose it. */
  draft?: string
  /**
   * Alternate continuations displaced by an edit or a per-message regenerate, keyed by the id
   * of the turn right before the fork point (or `ROOT_FORK_KEY` when the very first turn was
   * the one edited/regenerated). `parent_message_id` makes Cortex's own thread a tree, so a
   * fork here is just "the branch that used to follow this point" - only one alternate is kept
   * per fork point; picking it again swaps in place rather than stacking a history.
   */
  forks?: Record<string, ConversationTurn[]>
}

export const ROOT_FORK_KEY = '__root__'

export type ActiveView = 'chat' | 'agents' | 'search'

export interface ChatStore {
  // Agent selection
  agents: AgentEntry[]
  activeAgentFqn: string
  setAgents: (agents: AgentEntry[]) => void
  setActiveAgent: (fqn: string) => void

  // Thread list (sidebar summaries)
  threadSummaries: ThreadSummary[]
  setThreadSummaries: (summaries: ThreadSummary[]) => void

  // Open threads (keyed by tempId)
  openThreads: Record<string, OpenThread>
  activeThreadTempId: string | null

  // Active view (store-driven routing)
  activeView: ActiveView
  setActiveView: (v: ActiveView) => void

  // UI controls / feature flags
  showSql: boolean
  extendedThinking: boolean
  deepResearch: boolean
  webSearch: boolean
  toggleShowSql: () => void
  toggleExtendedThinking: () => void
  toggleDeepResearch: () => void
  toggleWebSearch: () => void

  // Selected artifact (drives right panel)
  selectedArtifact: Artifact | null
  selectArtifact: (a: Artifact | null) => void

  // Selected citation set (drives right panel, mutually exclusive with selectedArtifact)
  selectedCitations: Citation[] | null
  selectCitations: (c: Citation[] | null) => void

  // Selected agent details panel (drives right panel, mutually exclusive with the above two)
  selectedAgentDetails: AgentDetails | null
  selectedAgentDetailsName: string | null
  selectAgentDetails: (d: AgentDetails | null, name?: string) => void

  // Actions
  newThread: (agentFqn?: string) => string           // returns tempId
  activateThread: (tempId: string) => void
  closeThread: (tempId: string) => void
  hydrateThread: (tempId: string, turns: ConversationTurn[], threadId: number, lastMessageId?: number) => void
  appendTurn: (tempId: string, turn: ConversationTurn) => void
  setDraft: (tempId: string, draft: string) => void
  forkAt: (tempId: string, turnId: string) => void
  switchFork: (tempId: string, forkKey: string) => void
  updateTurn: (tempId: string, turnId: string, fn: (t: ConversationTurn) => ConversationTurn) => void
  setThreadId: (tempId: string, threadId: number, messageId?: number) => void
  setStreaming: (tempId: string, streaming: boolean) => void
  reconcileThreadId: (tempId: string, threadId: number, messageId?: number) => void
  updateSummaryName: (threadId: number, name: string) => void
  upsertSummary: (summary: ThreadSummary) => void
  removeSummary: (threadId: number) => void
}

function makeTempId() { return uuid() }

// A turn frozen mid-stream by a reload has no way to resume itself - the SSE connection is
// gone. Rather than leave it looking broken forever, downgrade it to an "interrupted" error so
// the UI can offer a refresh action instead of a permanently spinning cursor. Exported as a pure
// function so it's testable independent of zustand's rehydration lifecycle.
export function markInterruptedTurns(openThreads: Record<string, OpenThread>): Record<string, OpenThread> {
  const out: Record<string, OpenThread> = {}
  for (const [tempId, thread] of Object.entries(openThreads)) {
    out[tempId] = {
      ...thread,
      isStreaming: false,
      turns: thread.turns.map((t) =>
        t.status === 'streaming' ? { ...t, status: 'error', interrupted: true } : t
      ),
    }
  }
  return out
}

/**
 * Drops artifact payloads - a table's full row data, a chart's Vega spec - from the turns
 * written to sessionStorage, keeping only enough to render a placeholder.
 *
 * Those payloads are by far the largest thing in the store (a single table can be megabytes)
 * and they dominated the serialization cost of every persist write. They're also the least
 * worth persisting: this key only exists to recover a turn a reload caught mid-stream, and such
 * a turn is already downgraded to `interrupted` by markInterruptedTurns and offered a "Refresh
 * this thread" action, which re-fetches the real artifacts from the Threads API. So a recovered
 * table renders as an empty placeholder until the user takes the action the UI is already
 * pointing them at - see TableArtifact/ChartArtifact's own missing-payload guards.
 */
export function stripArtifactPayloads(openThreads: Record<string, OpenThread>): Record<string, OpenThread> {
  const out: Record<string, OpenThread> = {}
  for (const [tempId, thread] of Object.entries(openThreads)) {
    out[tempId] = {
      ...thread,
      turns: thread.turns.map((t) =>
        t.artifacts.length === 0 ? t : {
          ...t,
          artifacts: t.artifacts.map((a) => a.type === 'table'
            ? { id: a.id, type: 'table' as const, rowType: [], data: [], queryId: a.queryId, numRows: a.numRows, title: a.title }
            : a.type === 'map'
              ? { id: a.id, type: 'map' as const, spec: undefined as never, toolUseId: a.toolUseId }
              : { id: a.id, type: 'chart' as const, spec: undefined as never, toolUseId: a.toolUseId }),
        }
      ),
    }
  }
  return out
}

export const useChatStore = create<ChatStore>()(persist(persist((set, get) => ({
  agents: [],
  activeAgentFqn: '',
  setAgents: (agents) => set({ agents }),
  // Same FQN is a no-op (must not spawn a second empty thread). An empty active
  // thread is retargeted in place so starter questions follow the new agent. A
  // thread that already has turns keeps its agent and a fresh empty chat starts.
  setActiveAgent: (fqn) => {
    const s = get()
    const tempId = s.activeThreadTempId
    const active = tempId ? s.openThreads[tempId] : null
    if (s.activeAgentFqn === fqn && (!active || active.agentFqn === fqn)) return

    if (active && active.turns.length === 0) {
      set({
        activeAgentFqn: fqn,
        openThreads: { ...s.openThreads, [tempId!]: { ...active, agentFqn: fqn } },
      })
      return
    }

    if (active && active.turns.length > 0) {
      const nextTempId = makeTempId()
      set({
        activeAgentFqn: fqn,
        openThreads: {
          ...s.openThreads,
          [nextTempId]: { tempId: nextTempId, agentFqn: fqn, turns: [], thread: {}, isStreaming: false },
        },
        activeThreadTempId: nextTempId,
      })
      return
    }

    set({ activeAgentFqn: fqn })
  },

  threadSummaries: [],
  setThreadSummaries: (summaries) => set({ threadSummaries: summaries }),

  openThreads: {},
  activeThreadTempId: null,

  activeView: 'chat',
  setActiveView: (v) => set({ activeView: v }),

  showSql: false,
  extendedThinking: false,
  deepResearch: false,
  // Defaults on: unlike Deep Research (an expensive opt-in), web search is just one of the
  // agent's normal tools when configured - matching the native app's default-on toggle.
  webSearch: true,
  toggleShowSql: () => set((s) => ({ showSql: !s.showSql })),
  toggleExtendedThinking: () => set((s) => ({ extendedThinking: !s.extendedThinking })),
  toggleDeepResearch: () => set((s) => ({ deepResearch: !s.deepResearch })),
  toggleWebSearch: () => set((s) => ({ webSearch: !s.webSearch })),

  selectedArtifact: null,
  selectArtifact: (a) => set({
    selectedArtifact: a,
    selectedAgentDetails: a ? null : get().selectedAgentDetails,
    selectedAgentDetailsName: a ? null : get().selectedAgentDetailsName,
  }),

  selectedCitations: null,
  selectCitations: (c) => set({
    selectedCitations: c,
    selectedAgentDetails: c ? null : get().selectedAgentDetails,
    selectedAgentDetailsName: c ? null : get().selectedAgentDetailsName,
  }),

  selectedAgentDetails: null,
  selectedAgentDetailsName: null,
  selectAgentDetails: (d, name) => set({
    selectedAgentDetails: d,
    selectedAgentDetailsName: d ? (name ?? null) : null,
    selectedArtifact: d ? null : get().selectedArtifact,
    selectedCitations: d ? null : get().selectedCitations,
  }),

  newThread: (agentFqn) => {
    const fqn = agentFqn ?? get().activeAgentFqn
    const tempId = makeTempId()
    set((s) => ({
      openThreads: {
        ...s.openThreads,
        [tempId]: { tempId, agentFqn: fqn, turns: [], thread: {}, isStreaming: false },
      },
      activeThreadTempId: tempId,
    }))
    return tempId
  },

  activateThread: (tempId) => set({ activeThreadTempId: tempId }),

  closeThread: (tempId) => set((s) => {
    const { [tempId]: _removed, ...rest } = s.openThreads
    const nextActive = s.activeThreadTempId === tempId
      ? (Object.keys(rest)[0] ?? null)
      : s.activeThreadTempId
    return { openThreads: rest, activeThreadTempId: nextActive }
  }),

  hydrateThread: (tempId, turns, threadId, lastMessageId) => set((s) => {
    const t = s.openThreads[tempId]
    if (!t) return s
    return {
      openThreads: {
        ...s.openThreads,
        // Seed lastAssistantMessageId so the next turn chains parent_message_id off
        // the thread's most recent message (continuing context) instead of root (0).
        [tempId]: { ...t, turns, threadId, thread: { threadId, lastAssistantMessageId: lastMessageId } },
      },
    }
  }),

  appendTurn: (tempId, turn) => set((s) => {
    const t = s.openThreads[tempId]
    if (!t) return s
    return { openThreads: { ...s.openThreads, [tempId]: { ...t, turns: [...t.turns, turn] } } }
  }),

  updateTurn: (tempId, turnId, fn) => set((s) => {
    const t = s.openThreads[tempId]
    if (!t) return s
    return {
      openThreads: {
        ...s.openThreads,
        [tempId]: { ...t, turns: t.turns.map((tu) => (tu.id === turnId ? fn(tu) : tu)) },
      },
    }
  }),

  setDraft: (tempId, draft) => set((s) => {
    const t = s.openThreads[tempId]
    if (!t) return s
    return { openThreads: { ...s.openThreads, [tempId]: { ...t, draft } } }
  }),

  // Drops `turnId` and everything after it, stashing the removed suffix as a fork alternate so
  // an edit or a per-message regenerate is reversible via switchFork rather than destructive.
  forkAt: (tempId, turnId) => set((s) => {
    const t = s.openThreads[tempId]
    if (!t) return s
    const idx = t.turns.findIndex((tu) => tu.id === turnId)
    if (idx === -1) return s
    const kept = t.turns.slice(0, idx)
    const removed = t.turns.slice(idx)
    if (removed.length === 0) return s
    const forkKey = kept.length > 0 ? kept[kept.length - 1].id : ROOT_FORK_KEY
    const lastAssistant = [...kept].reverse().find((tu) => tu.role === 'assistant')
    return {
      openThreads: {
        ...s.openThreads,
        [tempId]: {
          ...t,
          turns: kept,
          thread: { ...t.thread, lastAssistantMessageId: lastAssistant?.messageId },
          forks: { ...(t.forks ?? {}), [forkKey]: removed },
        },
      },
    }
  }),

  // Swaps the branch stored under `forkKey` back in, pushing what's currently there back into
  // forks so switching is reversible in either direction.
  switchFork: (tempId, forkKey) => set((s) => {
    const t = s.openThreads[tempId]
    const alt = t?.forks?.[forkKey]
    if (!t || !alt) return s
    const anchorIdx = forkKey === ROOT_FORK_KEY ? 0 : t.turns.findIndex((tu) => tu.id === forkKey) + 1
    if (forkKey !== ROOT_FORK_KEY && anchorIdx === 0) return s // the anchor turn no longer exists
    const kept = t.turns.slice(0, anchorIdx)
    const currentSuffix = t.turns.slice(anchorIdx)
    const lastAssistant = [...alt].reverse().find((tu) => tu.role === 'assistant')
    return {
      openThreads: {
        ...s.openThreads,
        [tempId]: {
          ...t,
          turns: [...kept, ...alt],
          thread: { ...t.thread, lastAssistantMessageId: lastAssistant?.messageId ?? t.thread.lastAssistantMessageId },
          forks: { ...t.forks, [forkKey]: currentSuffix },
        },
      },
    }
  }),

  setThreadId: (tempId, threadId, messageId) => set((s) => {
    const t = s.openThreads[tempId]
    if (!t) return s
    return {
      openThreads: {
        ...s.openThreads,
        [tempId]: {
          ...t,
          threadId,
          thread: { threadId, lastAssistantMessageId: messageId ?? t.thread.lastAssistantMessageId },
        },
      },
    }
  }),

  reconcileThreadId: (tempId, threadId, messageId) => {
    get().setThreadId(tempId, threadId, messageId)
  },

  setStreaming: (tempId, streaming) => set((s) => {
    const t = s.openThreads[tempId]
    if (!t) return s
    return { openThreads: { ...s.openThreads, [tempId]: { ...t, isStreaming: streaming } } }
  }),

  updateSummaryName: (threadId, name) => set((s) => ({
    threadSummaries: s.threadSummaries.map((ts) =>
      ts.thread_id === threadId ? { ...ts, thread_name: name } : ts
    ),
  })),

  // Insert a freshly-created thread into the sidebar list (or update it if the
  // list has since been refreshed to include it). New threads created on the
  // first message aren't in threadSummaries until the next listThreads().
  upsertSummary: (summary) => set((s) => {
    const exists = s.threadSummaries.some((ts) => ts.thread_id === summary.thread_id)
    return {
      threadSummaries: exists
        ? s.threadSummaries.map((ts) => (ts.thread_id === summary.thread_id ? { ...ts, ...summary } : ts))
        : [summary, ...s.threadSummaries],
    }
  }),

  removeSummary: (threadId) => set((s) => ({
    threadSummaries: s.threadSummaries.filter((ts) => ts.thread_id !== threadId),
  })),
}), {
  // Nested inside the outer persist below (zustand supports composing persist middlewares,
  // each independently rehydrating from its own key) - kept separate from
  // 'agents_open_threads' because these are session-scoped UI preferences, not
  // conversation state. activeAgentFqn is deliberately NOT duplicated here - it already
  // persists via the outer persist below.
  name: 'agents_settings',
  storage: throttledSessionStorage(1000),
  partialize: (s) => ({
    showSql: s.showSql,
    extendedThinking: s.extendedThinking,
    deepResearch: s.deepResearch,
    webSearch: s.webSearch,
  }),
}), {
  name: 'agents_open_threads',
  // sessionStorage, not localStorage. Only the last-selected agent is restored; open
  // threads are not — a load always starts a blank chat (history is how you resume).
  // `merge` keeps live threads and ignores a legacy blob that still stored them.
  storage: throttledSessionStorage(1000),
  partialize: (s) => ({
    activeAgentFqn: s.activeAgentFqn,
  }),
  merge: (persisted, current) => {
    const stored = persisted as { activeAgentFqn?: string } | undefined
    return {
      ...current,
      activeAgentFqn: stored?.activeAgentFqn ?? current.activeAgentFqn,
    }
  },
}))
