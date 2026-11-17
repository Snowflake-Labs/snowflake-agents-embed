// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { AppShell } from './AppShell'
import { useChatStore } from '../../store/chatStore.js'
import { fetchAgents } from '../../api/agents.js'
import { resetFeatureFlags } from '../../lib/featureFlags.js'
import type { HostShellAdapter } from '../../host/hostShellAdapter.js'

vi.mock('../../api/agents.js', () => ({
  fetchAgents: vi.fn().mockResolvedValue([{ fqn: 'DB.SCH.AG', displayName: 'Agent' }]),
}))

const describeThread = vi.fn().mockResolvedValue({ thread_id: 42, messages: [] })
vi.mock('../../api/threads.js', () => ({
  describeThread: (...args: unknown[]) => describeThread(...args),
  listThreads: vi.fn().mockResolvedValue({ threads: [] }),
}))

vi.mock('../Chat/ChatContainer.js', () => ({ ChatContainer: () => null }))

const adapter: HostShellAdapter = {
  useAuth: () => ({
    ready: true,
    token: 'tok',
    loading: false,
    error: null,
    defaultAgentFqn: undefined,
    openThreadId: 42,
  }),
  useTheme: () => 'default',
  useShellEffects: () => {},
  ShareButton: () => null,
}

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
    selectedArtifact: null,
    selectedCitations: null,
  })
  describeThread.mockClear()
  vi.mocked(fetchAgents).mockReset().mockResolvedValue([{ fqn: 'DB.SCH.AG', displayName: 'Agent' }])
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  // AppShell's bootstrap effect fires loadFeatureFlags() -> GET /api/config; stub it so the
  // test doesn't attempt a real network connection (harmless since failures are swallowed,
  // but noisy and slow without this).
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
})
afterEach(() => { cleanup(); resetFeatureFlags(); vi.unstubAllGlobals() })

describe('AppShell deep-link + New Chat', () => {
  it('opens the deep-linked thread once and does not spike into a fetch loop', async () => {
    render(<AppShell adapter={adapter} />)

    await waitFor(() => expect(describeThread).toHaveBeenCalledTimes(1))
    expect(describeThread).toHaveBeenCalledWith('tok', 42)
  })

  it('starts a blank chat when the host has no thread to open', async () => {
    const noThreadAdapter: HostShellAdapter = {
      ...adapter,
      useAuth: () => ({ ...adapter.useAuth(), openThreadId: undefined }),
    }
    render(<AppShell adapter={noThreadAdapter} />)
    await waitFor(() => {
      const state = useChatStore.getState()
      const active = state.activeThreadTempId ? state.openThreads[state.activeThreadTempId] : undefined
      expect(active).toBeDefined()
      expect(active?.threadId).toBeUndefined()
      expect(active?.turns).toEqual([])
    })
    expect(describeThread).not.toHaveBeenCalled()
  })

  it('clicking New Chat keeps a fresh empty thread active instead of re-opening the deep link', async () => {
    render(<AppShell adapter={adapter} />)
    await waitFor(() => expect(describeThread).toHaveBeenCalledTimes(1))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /history/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /new chat/i }))
      // Give any runaway effect loop a chance to fire before asserting.
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(describeThread).toHaveBeenCalledTimes(1)
    const state = useChatStore.getState()
    const active = state.activeThreadTempId ? state.openThreads[state.activeThreadTempId] : undefined
    expect(active).toBeDefined()
    expect(active?.threadId).toBeUndefined()
    expect(active?.turns).toEqual([])
  })
})

describe('AppShell auth states', () => {
  it('shows an animated spinner alongside "Connecting..." while loading', () => {
    const loadingAdapter: HostShellAdapter = { ...adapter, useAuth: () => ({ ...adapter.useAuth(), loading: true, token: null }) }
    render(<AppShell adapter={loadingAdapter} />)
    expect(screen.getByText('Connecting...')).toBeTruthy()
    expect(document.querySelector('.spinner')).toBeTruthy()
  })

  it('renders a Try again button when the host provides onRetry, and calls it on click', () => {
    const onRetry = vi.fn()
    const errorAdapter: HostShellAdapter = {
      ...adapter,
      useAuth: () => ({ ...adapter.useAuth(), loading: false, token: null, error: 'OBO exchange failed', onRetry }),
    }
    render(<AppShell adapter={errorAdapter} />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('omits the Try again button when the host has no onRetry (ui)', () => {
    const errorAdapter: HostShellAdapter = {
      ...adapter,
      useAuth: () => ({ ...adapter.useAuth(), loading: false, token: null, error: 'No session from the Salesforce host' }),
    }
    render(<AppShell adapter={errorAdapter} />)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})

describe('AppShell layout', () => {
  // jsdom has no real layout engine, so this can't assert computed heights - it guards
  // against the wrapper regressing back to a bare, unstyled <div>. That regression is what
  // let a long first response (e.g. a table artifact) grow past .view-container's available
  // height with no flex sizing to stop it, silently clipping the composer off the bottom
  // instead of the message list scrolling. See layout.css's .chat-view-slot rule.
  it('gives the hidden ChatContainer wrapper the flex-sizing class instead of a bare div', () => {
    render(<AppShell adapter={adapter} />)
    const slot = document.querySelector('.chat-view-slot')
    expect(slot).toBeTruthy()
    expect(slot?.hasAttribute('hidden')).toBe(false)
  })
})

describe('AppShell agent bootstrap precedence', () => {
  const sales = { fqn: 'DB.SCH.SALES', displayName: 'Sales' }
  const threeSixty = { fqn: 'DB.SCH.360', displayName: '360' }

  function noThreadAdapter(overrides: Partial<ReturnType<HostShellAdapter['useAuth']>> = {}): HostShellAdapter {
    return {
      ...adapter,
      useAuth: () => ({ ...adapter.useAuth(), openThreadId: undefined, defaultAgentFqn: sales.fqn, ...overrides }),
    }
  }

  beforeEach(() => {
    vi.mocked(fetchAgents).mockReset().mockResolvedValue([sales, threeSixty])
  })

  it('keeps a persisted last-selected agent over the org default when it is still listed', async () => {
    useChatStore.setState({ activeAgentFqn: threeSixty.fqn })
    render(<AppShell adapter={noThreadAdapter()} />)
    await waitFor(() => expect(useChatStore.getState().activeAgentFqn).toBe(threeSixty.fqn))
    const active = useChatStore.getState().openThreads[useChatStore.getState().activeThreadTempId!]
    expect(active.agentFqn).toBe(threeSixty.fqn)
  })

  it('falls through to the org default when the persisted FQN is no longer in the list', async () => {
    useChatStore.setState({ activeAgentFqn: 'DB.SCH.GONE' })
    render(<AppShell adapter={noThreadAdapter()} />)
    await waitFor(() => expect(useChatStore.getState().activeAgentFqn).toBe(sales.fqn))
  })

  it('lets an explicit initialAgentFqn win over persist and the org default', async () => {
    useChatStore.setState({ activeAgentFqn: threeSixty.fqn })
    render(<AppShell adapter={noThreadAdapter()} initialAgentFqn={sales.fqn} />)
    await waitFor(() => expect(useChatStore.getState().activeAgentFqn).toBe(sales.fqn))
  })

  it('uses defaultAgentFqn from GET /api/config when the host does not supply one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ defaultAgentFqn: threeSixty.fqn }),
      { status: 200 },
    )))
    render(<AppShell adapter={noThreadAdapter({ defaultAgentFqn: undefined })} />)
    await waitFor(() => expect(useChatStore.getState().activeAgentFqn).toBe(threeSixty.fqn))
  })
})
