// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { AgentsView } from './AgentsView'
import { useChatStore } from '../../store/chatStore.js'

vi.mock('../../api/agents.js', () => ({
  fetchAgentDetailsCached: vi.fn(),
}))

beforeEach(() => {
  useChatStore.setState({
    agents: [
      { fqn: 'DB.SCH.SALES', displayName: 'Sales Agent', description: 'Answers sales questions' },
      { fqn: 'DB.SCH.OPS', displayName: 'Ops Agent', description: 'Handles operations queries' },
      { fqn: 'DB.SCH.MARKETING', displayName: 'Marketing Agent' },
      { fqn: 'DB.SCH.ANALYTICS_LONG_NAME_AGENT', displayName: 'ANALYTICS_LONG_NAME_AGENT', description: 'Agent with a long underscore name' },
    ],
    activeAgentFqn: 'DB.SCH.SALES',
    activeView: 'agents',
    openThreads: {},
    activeThreadTempId: null,
    selectedAgentDetails: null,
    selectedAgentDetailsName: null,
  })
})
afterEach(cleanup)

describe('AgentsView', () => {
  it('renders all agent cards', () => {
    render(<AgentsView snowflakeToken="tok" />)
    expect(screen.getByText('Sales Agent')).toBeTruthy()
    expect(screen.getByText('Ops Agent')).toBeTruthy()
    expect(screen.getByText('Marketing Agent')).toBeTruthy()
    expect(screen.getByText('ANALYTICS_LONG_NAME_AGENT')).toBeTruthy()
  })

  it('renders a long underscore name with its info button still present', () => {
    render(<AgentsView snowflakeToken="tok" />)
    const card = screen.getByText('ANALYTICS_LONG_NAME_AGENT').closest('.agent-card')
    expect(card).toBeTruthy()
    expect(card!.querySelector('.agent-card-info')).toBeTruthy()
    expect(card!.querySelector('.agent-card-name')?.textContent).toBe('ANALYTICS_LONG_NAME_AGENT')
  })

  it('filters agents by display name', () => {
    render(<AgentsView snowflakeToken="tok" />)
    const input = screen.getByRole('searchbox', { name: 'Filter agents' })
    fireEvent.change(input, { target: { value: 'sales' } })
    expect(screen.getByText('Sales Agent')).toBeTruthy()
    expect(screen.queryByText('Ops Agent')).toBeNull()
    expect(screen.queryByText('Marketing Agent')).toBeNull()
  })

  it('filters agents by description', () => {
    render(<AgentsView snowflakeToken="tok" />)
    const input = screen.getByRole('searchbox', { name: 'Filter agents' })
    fireEvent.change(input, { target: { value: 'operations' } })
    expect(screen.getByText('Ops Agent')).toBeTruthy()
    expect(screen.queryByText('Sales Agent')).toBeNull()
  })

  it('shows empty state when no agents match', () => {
    render(<AgentsView snowflakeToken="tok" />)
    const input = screen.getByRole('searchbox', { name: 'Filter agents' })
    fireEvent.change(input, { target: { value: 'zzznomatch' } })
    expect(screen.getByText('No agents found.')).toBeTruthy()
  })

  it('sorts agents A-Z when sort button is toggled', () => {
    const { container } = render(<AgentsView snowflakeToken="tok" />)
    const sortBtn = screen.getByTitle('Sort A–Z')
    fireEvent.click(sortBtn)
    const nameEls = container.querySelectorAll('.agent-card-name')
    const names = Array.from(nameEls).map((el) => el.textContent ?? '')
    expect(names[0]).toBe('ANALYTICS_LONG_NAME_AGENT')
    expect(names[1]).toBe('Marketing Agent')
    expect(names[2]).toBe('Ops Agent')
    expect(names[3]).toBe('Sales Agent')
  })

  it('clicking an agent card switches to chat view', () => {
    render(<AgentsView snowflakeToken="tok" />)
    const card = screen.getByText('Ops Agent').closest('button')!
    fireEvent.click(card)
    const state = useChatStore.getState()
    expect(state.activeAgentFqn).toBe('DB.SCH.OPS')
    expect(state.activeView).toBe('chat')
    expect(state.activeThreadTempId).not.toBeNull()
  })

  it('selecting a different agent on a thread with turns starts one new chat', () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.SALES')
    useChatStore.getState().appendTurn(tempId, {
      id: 'u1', role: 'user', text: 'hi', steps: [], citations: [], artifacts: [], status: 'done',
    })
    render(<AgentsView snowflakeToken="tok" />)
    fireEvent.click(screen.getByText('Ops Agent').closest('button')!)
    const state = useChatStore.getState()
    expect(state.activeAgentFqn).toBe('DB.SCH.OPS')
    expect(state.activeView).toBe('chat')
    expect(state.activeThreadTempId).not.toBe(tempId)
    expect(Object.keys(state.openThreads)).toHaveLength(2)
    expect(state.openThreads[state.activeThreadTempId!]).toMatchObject({ agentFqn: 'DB.SCH.OPS', turns: [] })
  })

  it('clicking the info button fetches details and opens the panel without switching chat', async () => {
    const { fetchAgentDetailsCached } = await import('../../api/agents.js')
    const details = { sampleQuestions: [], tools: [], dataSources: [], skills: [] }
    vi.mocked(fetchAgentDetailsCached).mockResolvedValue(details)
    const onOpenPanel = vi.fn()
    render(<AgentsView snowflakeToken="tok" onOpenPanel={onOpenPanel} />)
    const infoBtn = screen.getByText('Ops Agent').closest('.agent-card')!.querySelector('.agent-card-info')!
    fireEvent.click(infoBtn)
    await waitFor(() => expect(fetchAgentDetailsCached).toHaveBeenCalledWith('tok', 'DB.SCH.OPS'))
    const state = useChatStore.getState()
    expect(state.selectedAgentDetails).toEqual(details)
    expect(state.selectedAgentDetailsName).toBe('Ops Agent')
    expect(onOpenPanel).toHaveBeenCalled()
    expect(state.activeView).toBe('agents')
  })

  it('shows an inline error when the details fetch fails', async () => {
    const { fetchAgentDetailsCached } = await import('../../api/agents.js')
    vi.mocked(fetchAgentDetailsCached).mockResolvedValue(null)
    render(<AgentsView snowflakeToken="tok" />)
    const infoBtn = screen.getByText('Ops Agent').closest('.agent-card')!.querySelector('.agent-card-info')!
    fireEvent.click(infoBtn)
    await waitFor(() => expect(screen.getByText("Couldn't load details")).toBeTruthy())
  })
})
