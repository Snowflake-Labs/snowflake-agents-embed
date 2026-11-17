// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentPill } from './AgentPill'
import { useChatStore } from '../../../store/chatStore.js'

beforeEach(() => {
  useChatStore.setState({ agents: [], activeAgentFqn: '' })
})
afterEach(cleanup)

describe('AgentPill', () => {
  it('renders nothing when there are no agents', () => {
    const { container } = render(<AgentPill />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the active displayName with the full name in title', () => {
    useChatStore.setState({
      agents: [{ fqn: 'DB.SCH.A', displayName: 'Sales Agent', description: 'Helps with sales' }],
      activeAgentFqn: 'DB.SCH.A',
    })
    render(<AgentPill />)
    const button = screen.getByRole('button', { name: 'Sales Agent' })
    expect(button.getAttribute('title')).toBe('Sales Agent')
  })

  it('opens on click and lists every agent', async () => {
    useChatStore.setState({
      agents: [
        { fqn: 'DB.SCH.A', displayName: 'Sales Agent' },
        { fqn: 'DB.SCH.B', displayName: 'Ops Agent' },
      ],
      activeAgentFqn: 'DB.SCH.A',
    })
    render(<AgentPill />)
    await userEvent.click(screen.getByRole('button', { name: 'Sales Agent' }))
    expect(screen.getByRole('option', { name: /Sales Agent/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /Ops Agent/ })).toBeTruthy()
  })

  it('selecting a different agent on a thread with turns starts a new chat', async () => {
    const tempId = useChatStore.getState().newThread('DB.SCH.A')
    useChatStore.getState().appendTurn(tempId, {
      id: 'u1', role: 'user', text: 'hi', steps: [], citations: [], artifacts: [], status: 'done',
    })
    useChatStore.setState({
      agents: [
        { fqn: 'DB.SCH.A', displayName: 'Sales Agent' },
        { fqn: 'DB.SCH.B', displayName: 'Ops Agent' },
      ],
      activeAgentFqn: 'DB.SCH.A',
    })
    render(<AgentPill />)
    await userEvent.click(screen.getByRole('button', { name: 'Sales Agent' }))
    await userEvent.click(screen.getByRole('option', { name: /Ops Agent/ }))
    const s = useChatStore.getState()
    expect(s.activeAgentFqn).toBe('DB.SCH.B')
    expect(s.activeThreadTempId).not.toBe(tempId)
    expect(s.openThreads[s.activeThreadTempId!].turns).toEqual([])
    expect(s.openThreads[tempId].agentFqn).toBe('DB.SCH.A')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('selecting an agent calls setActiveAgent and closes the popover', async () => {
    useChatStore.setState({
      agents: [
        { fqn: 'DB.SCH.A', displayName: 'Sales Agent' },
        { fqn: 'DB.SCH.B', displayName: 'Ops Agent' },
      ],
      activeAgentFqn: 'DB.SCH.A',
    })
    render(<AgentPill />)
    await userEvent.click(screen.getByRole('button', { name: 'Sales Agent' }))
    await userEvent.click(screen.getByRole('option', { name: /Ops Agent/ }))
    expect(useChatStore.getState().activeAgentFqn).toBe('DB.SCH.B')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes on an outside mousedown', async () => {
    useChatStore.setState({
      agents: [{ fqn: 'DB.SCH.A', displayName: 'Sales Agent' }],
      activeAgentFqn: 'DB.SCH.A',
    })
    render(<AgentPill />)
    await userEvent.click(screen.getByRole('button', { name: 'Sales Agent' }))
    expect(screen.queryByRole('listbox')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
