// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useChatStore, markInterruptedTurns, ROOT_FORK_KEY } from './chatStore'

// Reset the store between tests
beforeEach(() => {
  useChatStore.setState({
    agents: [],
    activeAgentFqn: '',
    threadSummaries: [],
    openThreads: {},
    activeThreadTempId: null,
    activeView: 'chat',
    showSql: false,
    extendedThinking: false,
    deepResearch: false,
    webSearch: true,
    selectedArtifact: null,
    selectedCitations: null,
    selectedAgentDetails: null,
  })
})

describe('chatStore: thread lifecycle', () => {
  it('newThread creates an open thread and sets it as active', () => {
    const store = useChatStore.getState()
    const tempId = store.newThread('DB.SCH.AG')
    const s = useChatStore.getState()
    expect(s.activeThreadTempId).toBe(tempId)
    expect(s.openThreads[tempId]).toMatchObject({
      tempId,
      agentFqn: 'DB.SCH.AG',
      turns: [],
      isStreaming: false,
    })
  })

  it('appendTurn adds a turn to the active thread', () => {
    const { newThread, appendTurn } = useChatStore.getState()
    const tempId = newThread()
    appendTurn(tempId, {
      id: 'u1', role: 'user', text: 'hello', steps: [],
      citations: [], artifacts: [], status: 'done',
    })
    const t = useChatStore.getState().openThreads[tempId]
    expect(t.turns).toHaveLength(1)
    expect(t.turns[0].text).toBe('hello')
  })

  it('updateTurn mutates a specific turn by id', () => {
    const { newThread, appendTurn, updateTurn } = useChatStore.getState()
    const tempId = newThread()
    appendTurn(tempId, {
      id: 'a1', role: 'assistant', text: 'hi', steps: [],
      citations: [], artifacts: [], status: 'streaming',
    })
    updateTurn(tempId, 'a1', (t) => ({ ...t, text: t.text + ' world', status: 'done' }))
    const t = useChatStore.getState().openThreads[tempId]
    expect(t.turns[0].text).toBe('hi world')
    expect(t.turns[0].status).toBe('done')
  })

  it('reconcileThreadId stores the Cortex thread_id', () => {
    const { newThread, reconcileThreadId } = useChatStore.getState()
    const tempId = newThread()
    reconcileThreadId(tempId, 42, 7)
    const t = useChatStore.getState().openThreads[tempId]
    expect(t.threadId).toBe(42)
    expect(t.thread.threadId).toBe(42)
    expect(t.thread.lastAssistantMessageId).toBe(7)
  })

  it('setStreaming toggles the isStreaming flag', () => {
    const { newThread, setStreaming } = useChatStore.getState()
    const tempId = newThread()
    setStreaming(tempId, true)
    expect(useChatStore.getState().openThreads[tempId].isStreaming).toBe(true)
    setStreaming(tempId, false)
    expect(useChatStore.getState().openThreads[tempId].isStreaming).toBe(false)
  })

  it('setActiveAgent retargets the active thread while it is empty', () => {
    const { newThread, setActiveAgent } = useChatStore.getState()
    const tempId = newThread('DB.SCH.OLD')
    setActiveAgent('DB.SCH.NEW')
    const s = useChatStore.getState()
    expect(s.activeAgentFqn).toBe('DB.SCH.NEW')
    // Empty thread follows the newly selected agent — no "New chat" needed.
    expect(s.openThreads[tempId].agentFqn).toBe('DB.SCH.NEW')
  })

  it('setActiveAgent does not retarget a thread that already has turns; it starts a new empty chat', () => {
    const { newThread, appendTurn, setActiveAgent } = useChatStore.getState()
    const tempId = newThread('DB.SCH.OLD')
    appendTurn(tempId, {
      id: 'u1', role: 'user', text: 'hi', steps: [],
      citations: [], artifacts: [], status: 'done',
    })
    setActiveAgent('DB.SCH.NEW')
    const s = useChatStore.getState()
    expect(s.activeAgentFqn).toBe('DB.SCH.NEW')
    expect(s.openThreads[tempId].agentFqn).toBe('DB.SCH.OLD')
    expect(s.activeThreadTempId).not.toBe(tempId)
    const next = s.activeThreadTempId ? s.openThreads[s.activeThreadTempId] : undefined
    expect(next).toMatchObject({ agentFqn: 'DB.SCH.NEW', turns: [] })
  })

  it('setActiveAgent is a no-op when the same agent is already selected', () => {
    const { newThread, appendTurn, setActiveAgent } = useChatStore.getState()
    const tempId = newThread('DB.SCH.OLD')
    useChatStore.setState({ activeAgentFqn: 'DB.SCH.OLD' })
    appendTurn(tempId, {
      id: 'u1', role: 'user', text: 'hi', steps: [],
      citations: [], artifacts: [], status: 'done',
    })
    setActiveAgent('DB.SCH.OLD')
    const s = useChatStore.getState()
    expect(s.activeThreadTempId).toBe(tempId)
    expect(Object.keys(s.openThreads)).toHaveLength(1)
  })

  it('closeThread removes the thread and updates activeThreadTempId', () => {
    const { newThread, closeThread } = useChatStore.getState()
    const t1 = newThread()
    const t2 = newThread()
    expect(useChatStore.getState().activeThreadTempId).toBe(t2)
    closeThread(t2)
    const s = useChatStore.getState()
    expect(s.openThreads[t2]).toBeUndefined()
    expect(s.activeThreadTempId).toBe(t1)
  })

  it('hydrateThread replaces turns and sets threadId', () => {
    const { newThread, hydrateThread } = useChatStore.getState()
    const tempId = newThread()
    const turns = [{
      id: 'm1', role: 'user' as const, text: 'hi', steps: [],
      citations: [], artifacts: [], status: 'done' as const,
    }]
    hydrateThread(tempId, turns, 99)
    const t = useChatStore.getState().openThreads[tempId]
    expect(t.turns).toHaveLength(1)
    expect(t.threadId).toBe(99)
  })

  it('hydrateThread seeds lastAssistantMessageId for context chaining', () => {
    const { newThread, hydrateThread } = useChatStore.getState()
    const tempId = newThread()
    hydrateThread(tempId, [], 99, 288774)
    const t = useChatStore.getState().openThreads[tempId]
    expect(t.thread.threadId).toBe(99)
    expect(t.thread.lastAssistantMessageId).toBe(288774)
  })
})

describe('chatStore: activeView', () => {
  it('defaults to chat', () => {
    expect(useChatStore.getState().activeView).toBe('chat')
  })

  it('setActiveView updates activeView', () => {
    useChatStore.getState().setActiveView('agents')
    expect(useChatStore.getState().activeView).toBe('agents')
    useChatStore.getState().setActiveView('search')
    expect(useChatStore.getState().activeView).toBe('search')
    useChatStore.getState().setActiveView('chat')
    expect(useChatStore.getState().activeView).toBe('chat')
  })
})

describe('chatStore: controls + artifact selection', () => {
  it('toggleShowSql flips showSql', () => {
    expect(useChatStore.getState().showSql).toBe(false)
    useChatStore.getState().toggleShowSql()
    expect(useChatStore.getState().showSql).toBe(true)
    useChatStore.getState().toggleShowSql()
    expect(useChatStore.getState().showSql).toBe(false)
  })

  it('toggleExtendedThinking flips extendedThinking', () => {
    useChatStore.getState().toggleExtendedThinking()
    expect(useChatStore.getState().extendedThinking).toBe(true)
  })

  it('selectArtifact sets and clears selectedArtifact', () => {
    const artifact = { id: 'a1', type: 'chart' as const, spec: {} }
    useChatStore.getState().selectArtifact(artifact)
    expect(useChatStore.getState().selectedArtifact).toEqual(artifact)
    useChatStore.getState().selectArtifact(null)
    expect(useChatStore.getState().selectedArtifact).toBeNull()
  })

  it('selectCitations sets and clears selectedCitations', () => {
    const citations = [{ index: 1, docTitle: 'Doc A', url: 'https://a' }]
    useChatStore.getState().selectCitations(citations)
    expect(useChatStore.getState().selectedCitations).toEqual(citations)
    useChatStore.getState().selectCitations(null)
    expect(useChatStore.getState().selectedCitations).toBeNull()
  })

  it('selectArtifact and selectCitations both clear selectedAgentDetails; selectAgentDetails clears both of those', () => {
    const artifact = { id: 'a1', type: 'chart' as const, spec: {} }
    const citations = [{ index: 1, docTitle: 'Doc A' }]
    const details = { sampleQuestions: [], tools: [], dataSources: [], skills: [] }

    useChatStore.getState().selectAgentDetails(details)
    useChatStore.getState().selectArtifact(artifact)
    expect(useChatStore.getState().selectedAgentDetails).toBeNull()

    useChatStore.getState().selectAgentDetails(details)
    useChatStore.getState().selectCitations(citations)
    expect(useChatStore.getState().selectedAgentDetails).toBeNull()

    useChatStore.getState().selectAgentDetails(details)
    expect(useChatStore.getState()).toMatchObject({ selectedArtifact: null, selectedCitations: null, selectedAgentDetails: details })
  })
})

describe('chatStore: thread summaries', () => {
  it('updateSummaryName renames a summary in place', () => {
    useChatStore.setState({ threadSummaries: [{ thread_id: 1, thread_name: 'Old' }] })
    useChatStore.getState().updateSummaryName(1, 'New Name')
    expect(useChatStore.getState().threadSummaries[0].thread_name).toBe('New Name')
  })

  it('removeSummary removes a summary by id', () => {
    useChatStore.setState({ threadSummaries: [{ thread_id: 1 }, { thread_id: 2 }] })
    useChatStore.getState().removeSummary(1)
    const ids = useChatStore.getState().threadSummaries.map((t) => t.thread_id)
    expect(ids).toEqual([2])
  })
})

describe('chatStore: forkAt / switchFork', () => {
  function seedThread() {
    const tempId = useChatStore.getState().newThread('DB.SCH.AG')
    const turns = [
      { id: 'u1', role: 'user' as const, text: 'first question', steps: [], citations: [], artifacts: [], status: 'done' as const },
      { id: 'a1', role: 'assistant' as const, text: 'first answer', messageId: 100, steps: [], citations: [], artifacts: [], status: 'done' as const },
      { id: 'u2', role: 'user' as const, text: 'second question', steps: [], citations: [], artifacts: [], status: 'done' as const },
      { id: 'a2', role: 'assistant' as const, text: 'second answer', messageId: 200, steps: [], citations: [], artifacts: [], status: 'done' as const },
    ]
    useChatStore.setState((s) => ({
      openThreads: { ...s.openThreads, [tempId]: { ...s.openThreads[tempId], turns, thread: { threadId: 9, lastAssistantMessageId: 200 } } },
    }))
    return tempId
  }

  it('drops the turn and everything after it, stashing the removed suffix under the preceding turn id', () => {
    const tempId = seedThread()
    useChatStore.getState().forkAt(tempId, 'u2')
    const t = useChatStore.getState().openThreads[tempId]
    expect(t.turns.map((tu) => tu.id)).toEqual(['u1', 'a1'])
    expect(t.forks?.a1?.map((tu) => tu.id)).toEqual(['u2', 'a2'])
  })

  it('recomputes lastAssistantMessageId off the kept turns', () => {
    const tempId = seedThread()
    useChatStore.getState().forkAt(tempId, 'u2')
    expect(useChatStore.getState().openThreads[tempId].thread.lastAssistantMessageId).toBe(100)
  })

  it('stashes under ROOT_FORK_KEY when the very first turn is forked', () => {
    const tempId = seedThread()
    useChatStore.getState().forkAt(tempId, 'u1')
    const t = useChatStore.getState().openThreads[tempId]
    expect(t.turns).toEqual([])
    expect(t.thread.lastAssistantMessageId).toBeUndefined()
    expect(t.forks?.[ROOT_FORK_KEY]?.map((tu) => tu.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('is a no-op for an unknown turn id or a turn with nothing after it', () => {
    const tempId = seedThread()
    const before = useChatStore.getState().openThreads[tempId]
    useChatStore.getState().forkAt(tempId, 'missing')
    expect(useChatStore.getState().openThreads[tempId]).toBe(before)
  })

  it('switchFork swaps the stored alternate back in and stashes the current suffix in its place', () => {
    const tempId = seedThread()
    useChatStore.getState().forkAt(tempId, 'u2')
    useChatStore.getState().appendTurn(tempId, {
      id: 'u3', role: 'user', text: 'edited second question', steps: [], citations: [], artifacts: [], status: 'done',
    })

    useChatStore.getState().switchFork(tempId, 'a1')
    const t = useChatStore.getState().openThreads[tempId]
    expect(t.turns.map((tu) => tu.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(t.thread.lastAssistantMessageId).toBe(200)
    expect(t.forks?.a1?.map((tu) => tu.id)).toEqual(['u3'])
  })

  it('is a no-op when there is no alternate stored for that key', () => {
    const tempId = seedThread()
    const before = useChatStore.getState().openThreads[tempId]
    useChatStore.getState().switchFork(tempId, 'a1')
    expect(useChatStore.getState().openThreads[tempId]).toBe(before)
  })
})

describe('markInterruptedTurns', () => {
  function openThread(overrides: Partial<import('./chatStore').OpenThread> = {}) {
    return {
      tempId: 't1', agentFqn: 'DB.SCH.AG', turns: [], thread: {}, isStreaming: true,
      ...overrides,
    }
  }

  it('downgrades a streaming turn to an interrupted error and clears isStreaming', () => {
    const input = {
      t1: openThread({
        turns: [{
          id: 'a1', role: 'assistant' as const, text: 'partial', steps: [],
          citations: [], artifacts: [], status: 'streaming' as const,
        }],
      }),
    }
    const out = markInterruptedTurns(input)
    expect(out.t1.isStreaming).toBe(false)
    expect(out.t1.turns[0]).toMatchObject({ status: 'error', interrupted: true })
  })

  it('leaves done/error turns and their threads untouched', () => {
    const input = {
      t1: openThread({
        isStreaming: false,
        turns: [{
          id: 'a1', role: 'assistant' as const, text: 'done', steps: [],
          citations: [], artifacts: [], status: 'done' as const,
        }],
      }),
    }
    const out = markInterruptedTurns(input)
    expect(out.t1.turns[0]).toEqual(input.t1.turns[0])
  })
})

describe('chatStore: setDraft', () => {
  it('sets the draft on the given thread without touching others', () => {
    const { newThread, setDraft } = useChatStore.getState()
    const t1 = newThread('DB.SCH.AG')
    const t2 = newThread('DB.SCH.AG')
    setDraft(t1, 'in progress...')
    const s = useChatStore.getState()
    expect(s.openThreads[t1].draft).toBe('in progress...')
    expect(s.openThreads[t2].draft).toBeUndefined()
  })

  it('is a no-op for a tempId that does not exist', () => {
    const before = useChatStore.getState().openThreads
    useChatStore.getState().setDraft('missing', 'x')
    expect(useChatStore.getState().openThreads).toBe(before)
  })
})

// The conversation-state key is written through throttledSessionStorage, so these advance
// timers rather than reading straight after the mutation.
describe('chatStore: sessionStorage persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // The outer beforeEach's setState already queued a write under real timers, and the
    // debounce won't schedule a second one while that's outstanding - so advanceTimersByTime
    // would never reach it. pagehide flushes and cancels it, leaving a clean slate.
    dispatchEvent(new Event('pagehide'))
    sessionStorage.clear()
  })
  afterEach(() => { vi.useRealTimers() })

  it('persists activeAgentFqn to sessionStorage and not the open thread', () => {
    sessionStorage.removeItem('agents_open_threads')
    useChatStore.getState().setActiveAgent('DB.SCH.AG')
    vi.advanceTimersByTime(1000)
    const raw = sessionStorage.getItem('agents_open_threads')
    expect(raw).toBeTruthy()
    const persisted = JSON.parse(raw!)
    expect(persisted.state.activeAgentFqn).toBe('DB.SCH.AG')
    expect(persisted.state.activeThreadTempId).toBeUndefined()
    expect(persisted.state.openThreads).toBeUndefined()
  })

  it('persists showSql/extendedThinking/deepResearch under their own separate key', () => {
    sessionStorage.removeItem('agents_settings')
    useChatStore.getState().toggleShowSql()
    useChatStore.getState().toggleExtendedThinking()
    expect(sessionStorage.getItem('agents_settings')).toBeNull()
    vi.advanceTimersByTime(1000)
    const raw = sessionStorage.getItem('agents_settings')
    expect(raw).toBeTruthy()
    const persisted = JSON.parse(raw!)
    expect(persisted.state).toEqual({ showSql: true, extendedThinking: true, deepResearch: false, webSearch: true })
    // Not duplicated into the agent-selection key.
    useChatStore.getState().setActiveAgent('DB.SCH.AG')
    vi.advanceTimersByTime(1000)
    const openThreadsRaw = JSON.parse(sessionStorage.getItem('agents_open_threads')!)
    expect(openThreadsRaw.state.showSql).toBeUndefined()
    expect(openThreadsRaw.state.activeAgentFqn).toBe('DB.SCH.AG')
  })

  it('coalesces a burst of mutations into a single write', () => {
    sessionStorage.removeItem('agents_open_threads')
    const { setActiveAgent } = useChatStore.getState()
    for (let i = 0; i < 50; i++) setActiveAgent(`DB.SCH.AG${i}`)
    expect(sessionStorage.getItem('agents_open_threads')).toBeNull()
    vi.advanceTimersByTime(1000)
    const persisted = JSON.parse(sessionStorage.getItem('agents_open_threads')!)
    expect(persisted.state.activeAgentFqn).toBe('DB.SCH.AG49')
  })
})
