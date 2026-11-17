// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ChatControls } from './ChatControls'
import { useChatStore } from '../store/chatStore'
import type { ConversationTurn } from '../types'

vi.mock('../api/agents.js', () => ({
  fetchAgentDetailsCached: vi.fn(),
}))

beforeEach(() => {
  useChatStore.setState({ activeAgentFqn: 'DB.SCH.A', selectedAgentDetails: null, showSql: false })
})
afterEach(() => { vi.clearAllMocks() })

describe('ChatControls', () => {
  it('renders no "Agent details" button without a snowflakeToken', () => {
    render(<ChatControls />)
    expect(screen.queryByRole('button', { name: /Agent details/ })).toBeNull()
  })

  it('fetches and selects agent details, then opens the panel', async () => {
    const { fetchAgentDetailsCached } = await import('../api/agents.js')
    const details = { orchestrationModel: 'claude-sonnet-4-5', sampleQuestions: [], tools: [], dataSources: [], skills: [] }
    vi.mocked(fetchAgentDetailsCached).mockResolvedValue(details)
    const onOpenPanel = vi.fn()

    render(<ChatControls snowflakeToken="tok" onOpenPanel={onOpenPanel} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent details/ }))

    await waitFor(() => expect(useChatStore.getState().selectedAgentDetails).toEqual(details))
    expect(fetchAgentDetailsCached).toHaveBeenCalledWith('tok', 'DB.SCH.A')
    expect(onOpenPanel).toHaveBeenCalledOnce()
  })

  it('shows an inline error and does not open the panel when the fetch fails', async () => {
    const { fetchAgentDetailsCached } = await import('../api/agents.js')
    vi.mocked(fetchAgentDetailsCached).mockResolvedValue(null)
    const onOpenPanel = vi.fn()

    render(<ChatControls snowflakeToken="tok" onOpenPanel={onOpenPanel} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent details/ }))

    await waitFor(() => expect(screen.getByText('Could not load agent details')).toBeTruthy())
    expect(onOpenPanel).not.toHaveBeenCalled()
  })

  it('toggles showSql', () => {
    render(<ChatControls />)
    fireEvent.click(screen.getByRole('button', { name: 'SQL' }))
    expect(useChatStore.getState().showSql).toBe(true)
  })

  it('badges Agent details when the latest assistant turn has a warning', () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.A')
    useChatStore.setState((s) => ({
      openThreads: {
        ...s.openThreads,
        [tempId]: {
          ...s.openThreads[tempId],
          turns: [{
            id: 't1', role: 'assistant', steps: [], text: 'ok', citations: [], artifacts: [],
            status: 'done',
            warnings: [{ message: "TOOL_NOT_ACCESSIBLE: DEMO_DB.AGENTS.JIRA_MCP (mcp_server) - MCP server 'DEMO_DB.AGENTS.JIRA_MCP' denied." }],
          }],
        },
      },
      activeThreadTempId: tempId,
    }))
    render(<ChatControls snowflakeToken="tok" />)
    expect(screen.getByLabelText('1 warning')).toBeTruthy()
  })
})

describe('ChatControls copy chat', () => {
  function seedThread(turns: Partial<ConversationTurn>[]) {
    const tempId = useChatStore.getState().newThread('DB.SCH.A')
    useChatStore.setState((s) => ({
      openThreads: {
        ...s.openThreads,
        [tempId]: {
          ...s.openThreads[tempId],
          turns: turns.map((t, i) => ({
            id: String(i), role: 'assistant', steps: [], text: '',
            citations: [], artifacts: [], status: 'done', ...t,
          }) as ConversationTurn),
        },
      },
      activeThreadTempId: tempId,
    }))
    return tempId
  }

  it('is disabled until an answer has landed', () => {
    seedThread([{ role: 'user', text: 'What are sales by region?' }])
    render(<ChatControls />)
    expect(screen.getByRole('button', { name: 'Copy chat' })).toHaveProperty('disabled', true)
  })

  it('copies every turn of the active thread, titled from the thread summary', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    const tempId = seedThread([
      { role: 'user', text: 'What are sales by region?' },
      { text: 'Central leads.' },
      { role: 'user', text: 'And profit?' },
      { text: 'South is thinnest.' },
    ])
    useChatStore.getState().setThreadId(tempId, 42)
    useChatStore.setState({
      threadSummaries: [{ thread_id: 42, thread_name: 'Regional Sales' } as any],
    })

    render(<ChatControls />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy chat' })) })

    const copied = writeText.mock.calls[0][0]
    expect(copied).toContain('# Regional Sales')
    expect(copied).toContain('**You:** What are sales by region?')
    expect(copied).toContain('Central leads.')
    expect(copied).toContain('South is thinnest.')

    vi.unstubAllGlobals()
  })
})
