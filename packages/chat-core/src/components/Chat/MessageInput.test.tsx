// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MessageInput } from './MessageInput'
import { useChatStore } from '../../store/chatStore'
import { setFeatureFlags, resetFeatureFlags } from '../../lib/featureFlags'

beforeEach(() => {
  useChatStore.setState({
    openThreads: {}, activeThreadTempId: null, agents: [], activeAgentFqn: '',
  })
})

describe('MessageInput keyboard shortcuts', () => {
  it('sends on Enter and lets Shift+Enter insert a newline instead', async () => {
    const onSend = vi.fn()
    render(<MessageInput onSend={onSend} />)
    const textarea = screen.getByPlaceholderText('Ask anything...')

    await userEvent.type(textarea, 'hello{Shift>}{Enter}{/Shift}world')
    expect(onSend).not.toHaveBeenCalled()
    expect((textarea as HTMLTextAreaElement).value).toBe('hello\nworld')

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(onSend).toHaveBeenCalledWith('hello\nworld', [], [])
  })

  it('clears the composer on Escape', async () => {
    const onSend = vi.fn()
    render(<MessageInput onSend={onSend} />)
    const textarea = screen.getByPlaceholderText('Ask anything...') as HTMLTextAreaElement
    await userEvent.type(textarea, 'scratch that')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(textarea.value).toBe('')
  })
})

describe('MessageInput Send button visibility', () => {
  it('shows no Send button until there is something to send', () => {
    render(<MessageInput onSend={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })

  it('reveals Send once text is typed, and Enter still sends without needing it', async () => {
    const onSend = vi.fn()
    render(<MessageInput onSend={onSend} />)
    const textarea = screen.getByPlaceholderText('Ask anything...')

    await userEvent.type(textarea, 'hi')
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(onSend).toHaveBeenCalledWith('hi', [], [])
  })

  it('hides Send again once the message has been sent', async () => {
    render(<MessageInput onSend={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('Ask anything...')

    await userEvent.type(textarea, 'hi')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })
})

describe('MessageInput draft persistence', () => {
  it('writes keystrokes into the thread draft and restores it when the thread becomes active again', async () => {
    const t1 = useChatStore.getState().newThread('DB.SCH.A')
    const t2 = useChatStore.getState().newThread('DB.SCH.A')

    const { rerender } = render(<MessageInput onSend={vi.fn()} tempId={t1} />)
    await userEvent.type(screen.getByPlaceholderText('Ask anything...'), 'draft one')
    expect(useChatStore.getState().openThreads[t1].draft).toBe('draft one')

    rerender(<MessageInput onSend={vi.fn()} tempId={t2} />)
    expect((screen.getByPlaceholderText('Ask anything...') as HTMLTextAreaElement).value).toBe('')

    rerender(<MessageInput onSend={vi.fn()} tempId={t1} />)
    expect((screen.getByPlaceholderText('Ask anything...') as HTMLTextAreaElement).value).toBe('draft one')
  })

  it('clears the persisted draft once the message is sent', async () => {
    const t1 = useChatStore.getState().newThread('DB.SCH.A')
    render(<MessageInput onSend={vi.fn()} tempId={t1} />)
    const textarea = screen.getByPlaceholderText('Ask anything...')
    await userEvent.type(textarea, 'send me')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(useChatStore.getState().openThreads[t1].draft).toBe('')
  })

  it('focuses the composer when switching to a different thread', () => {
    const t1 = useChatStore.getState().newThread('DB.SCH.A')
    const t2 = useChatStore.getState().newThread('DB.SCH.A')
    const { rerender } = render(<MessageInput onSend={vi.fn()} tempId={t1} />)
    rerender(<MessageInput onSend={vi.fn()} tempId={t2} />)
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Ask anything...'))
  })

  it('does not steal focus into a disabled composer', () => {
    const t1 = useChatStore.getState().newThread('DB.SCH.A')
    const t2 = useChatStore.getState().newThread('DB.SCH.A')
    const { rerender } = render(<MessageInput onSend={vi.fn()} tempId={t1} disabled />)
    rerender(<MessageInput onSend={vi.fn()} tempId={t2} disabled />)
    expect(document.activeElement).not.toBe(screen.getByPlaceholderText('Ask anything...'))
  })
})

describe('MessageInput @-mention', () => {
  it('shows matching agents and switches the active agent on selection, removing the mention text', async () => {
    useChatStore.setState({
      agents: [
        { fqn: 'DB.SCH.SALES', displayName: 'Sales Analyst' },
        { fqn: 'DB.SCH.HR', displayName: 'HR Assistant' },
      ],
    })
    render(<MessageInput onSend={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('Ask anything...')

    await userEvent.type(textarea, 'hey @sales')
    expect(screen.getByText('Sales Analyst')).toBeTruthy()
    expect(screen.queryByText('HR Assistant')).toBeNull()

    await userEvent.click(screen.getByText('Sales Analyst'))
    expect(useChatStore.getState().activeAgentFqn).toBe('DB.SCH.SALES')
    expect((textarea as HTMLTextAreaElement).value).toBe('hey ')
  })

  it('mentioning a different agent on a thread with turns starts a new chat', async () => {
    useChatStore.setState({
      agents: [
        { fqn: 'DB.SCH.SALES', displayName: 'Sales Analyst' },
        { fqn: 'DB.SCH.HR', displayName: 'HR Assistant' },
      ],
      activeAgentFqn: 'DB.SCH.HR',
    })
    const tempId = useChatStore.getState().newThread('DB.SCH.HR')
    useChatStore.getState().appendTurn(tempId, {
      id: 'u1', role: 'user', text: 'hi', steps: [], citations: [], artifacts: [], status: 'done',
    })
    render(<MessageInput onSend={vi.fn()} tempId={tempId} />)
    await userEvent.type(screen.getByPlaceholderText('Ask anything...'), '@sales')
    await userEvent.click(screen.getByText('Sales Analyst'))
    const s = useChatStore.getState()
    expect(s.activeAgentFqn).toBe('DB.SCH.SALES')
    expect(s.activeThreadTempId).not.toBe(tempId)
    expect(s.openThreads[s.activeThreadTempId!].turns).toEqual([])
  })

  it('shows no mention menu once the @ token is closed by whitespace', async () => {
    useChatStore.setState({ agents: [{ fqn: 'DB.SCH.A', displayName: 'Agent A' }] })
    render(<MessageInput onSend={vi.fn()} />)
    await userEvent.type(screen.getByPlaceholderText('Ask anything...'), 'hey @a done')
    expect(screen.queryByText('Agent A')).toBeNull()
  })
})

// The Lexical path can't reliably be driven via userEvent.type() under happy-dom (see
// composer/LexicalComposerInput.test.tsx's own suite for that caveat), so these tests
// exercise it through real DOM events on the contenteditable root and the imperative
// handle's insert/remove methods rather than simulated keystrokes.
describe('MessageInput richComposer path', () => {
  beforeEach(() => {
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: true, nativeStreamFlags: false })
  })
  afterEach(() => resetFeatureFlags())

  it('renders the Lexical editor instead of a textarea', () => {
    render(<MessageInput onSend={vi.fn()} />)
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeTruthy()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('submits on a real Enter keydown against the contenteditable root', async () => {
    const onSend = vi.fn()
    render(<MessageInput onSend={onSend} />)
    const root = screen.getByTestId('lexical-composer-input')

    fireEvent.keyDown(root, { key: 'Enter', keyCode: 13 })
    // Nothing typed yet - Send stays disabled and onSend is not called for empty content.
    expect(onSend).not.toHaveBeenCalled()
  })

  it('restores a thread draft into the Lexical editor on thread switch', async () => {
    const t1 = useChatStore.getState().newThread('DB.SCH.A')
    const t2 = useChatStore.getState().newThread('DB.SCH.A')
    useChatStore.getState().setDraft(t1, 'draft one')

    const { rerender } = render(<MessageInput onSend={vi.fn()} tempId={t1} />)
    await waitFor(() => expect(screen.getByTestId('lexical-composer-input').textContent).toBe('draft one'))

    rerender(<MessageInput onSend={vi.fn()} tempId={t2} />)
    await waitFor(() => expect(screen.getByTestId('lexical-composer-input').textContent).toBe(''))
  })

  it('a real Escape keydown clears the editor content', async () => {
    const t1 = useChatStore.getState().newThread('DB.SCH.A')
    useChatStore.getState().setDraft(t1, 'scratch that')
    render(<MessageInput onSend={vi.fn()} tempId={t1} />)
    const root = screen.getByTestId('lexical-composer-input')
    await waitFor(() => expect(root.textContent).toBe('scratch that'))

    fireEvent.keyDown(root, { key: 'Escape', keyCode: 27 })
    await waitFor(() => expect(root.textContent).toBe(''))
    expect(useChatStore.getState().openThreads[t1].draft).toBe('')
  })
})

