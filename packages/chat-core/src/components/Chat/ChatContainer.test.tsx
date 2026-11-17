// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { ChatContainer } from './ChatContainer'
import { useChatStore, ROOT_FORK_KEY } from '../../store/chatStore'
import { fetchSampleQuestionsCached, fetchAgentDetailsCached } from '../../api/agents'
import { describeThread } from '../../api/threads'
import { setFeatureFlags, resetFeatureFlags } from '../../lib/featureFlags'

const stream = vi.fn().mockResolvedValue(undefined)
const FakeShareButton = () => null

vi.mock('../../hooks/useAgentStream.js', () => ({
  useAgentStream: () => ({ stream, stop: vi.fn() }),
}))
vi.mock('../../api/threads.js', async (importActual) => ({
  sortThreadMessages: (await importActual<typeof import('../../api/threads.js')>()).sortThreadMessages,
  createThread: vi.fn().mockResolvedValue({ thread_id: 11, created_at: '2026-09-01T12:00:00.000Z', updated_at: '2026-09-01T12:00:00.000Z' }),
  generateTitle: vi.fn().mockResolvedValue(''),
  renameThread: vi.fn().mockResolvedValue(undefined),
  describeThread: vi.fn(),
}))
vi.mock('../../api/agents.js', () => ({
  fetchSampleQuestionsCached: vi.fn().mockResolvedValue([]),
  fetchAgentDetailsCached: vi.fn(),
}))

async function send(text: string) {
  const inputs = screen.getAllByPlaceholderText('Ask anything...')
  await userEvent.type(inputs[inputs.length - 1], text)
  // Send only renders once there's something to send, so the query has to come after typing.
  const buttons = screen.getAllByRole('button', { name: 'Send' })
  await userEvent.click(buttons[buttons.length - 1])
}

describe('ChatContainer record context', () => {
  // Stands in for a host's buildContextPreamble prop (e.g. ui's record-context derivation,
  // tested on its own terms in packages/ui/src/host/hostContext.test.ts). This test is about
  // ChatContainer's own bookkeeping — when the preamble is sent and when it's skipped as
  // already-stated — not about how any one host derives the string.
  let preamble: string | undefined

  beforeEach(() => {
    stream.mockClear()
    preamble = undefined
    useChatStore.setState({ openThreads: {}, activeThreadTempId: null, threadSummaries: [] })
    useChatStore.getState().newThread('DB.SCHEMA.AGENT')
  })

  it('sends the typed question unchanged when there is no host context preamble', async () => {
    render(<ChatContainer snowflakeToken="t" connected ShareButton={FakeShareButton} />)
    await send('Which region had the highest profit?')

    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
    const first = stream.mock.calls[0][0]
    expect(first.query).toBe('Which region had the highest profit?')

    await send('And last quarter?')
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(2))
    expect(stream.mock.calls[1][0].query).toBe('And last quarter?')
  })

  it('prefixes the preamble once, then stops repeating it', async () => {
    preamble = 'Looking at Account: Acme Corp'
    render(
      <ChatContainer
        snowflakeToken="t"
        connected
        ShareButton={FakeShareButton}
        buildContextPreamble={() => preamble}
      />,
    )

    await send('How are they doing?')
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
    const first = stream.mock.calls[0][0]
    expect(first.query).toContain('Acme Corp')
    expect(first.query).toMatch(/How are they doing\?$/)

    // The transcript and the auto-title use what the user typed, not the augmented query.
    const turns = useChatStore.getState().openThreads[first.tempId].turns
    expect(turns[0].text).toBe('How are they doing?')

    await send('And last quarter?')
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(2))
    // Already stated in this thread - repeating it every turn would crowd the context
    // window and is exactly the noise the preamble is meant to avoid.
    expect(stream.mock.calls[1][0].query).toBe('And last quarter?')
  })

  it('re-states the context when it changes under a restored thread', async () => {
    preamble = 'Looking at Account: Acme Corp'
    render(
      <ChatContainer
        snowflakeToken="t"
        connected
        ShareButton={FakeShareButton}
        buildContextPreamble={() => preamble}
      />,
    )
    await send('Anything I should know?')
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))

    // A resumed thread can come back on a different context; the agent cannot tell from the
    // thread alone, so the preamble has to be sent again.
    preamble = 'Looking at Account: Globex'
    await send('And this one?')
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(2))
    expect(stream.mock.calls[1][0].query).toContain('Globex')
  })

  it('keeps date/user off the query and passes the name through to the stream', async () => {
    render(
      <ChatContainer
        snowflakeToken="t"
        connected
        ShareButton={FakeShareButton}
        currentUserName="Jordan Rivera"
      />,
    )

    await send('What changed today?')
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
    const first = stream.mock.calls[0][0]
    expect(first.query).toBe('What changed today?')
    expect(first.currentUserName).toBe('Jordan Rivera')

    // The transcript still shows only what the user typed.
    const turns = useChatStore.getState().openThreads[first.tempId].turns
    expect(turns[0].text).toBe('What changed today?')
  })
})

/**
 * Phase 1 puts no Snowflake credential in the browser, so `snowflakeToken` is '' on a
 * perfectly healthy session and readiness has to come from the host handshake instead.
 * Every one of these pins a defect reported from the org.
 */
describe('ChatContainer readiness', () => {
  beforeEach(() => {
    stream.mockClear()
    vi.mocked(fetchSampleQuestionsCached).mockReset().mockResolvedValue([])
    useChatStore.setState({ openThreads: {}, activeThreadTempId: null, threadSummaries: [] })
    useChatStore.getState().newThread('DB.SCHEMA.AGENT')
  })

  it('lets the user type once the host session lands, even with no token', async () => {
    render(<ChatContainer snowflakeToken="" connected ShareButton={FakeShareButton} />)
    const inputs = screen.getAllByPlaceholderText('Ask anything...') as HTMLTextAreaElement[]
    expect(inputs[inputs.length - 1].disabled).toBe(false)

    await send('Which region had the highest profit?')
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
  })

  it('holds the composer shut until the session lands', () => {
    render(<ChatContainer snowflakeToken="" connected={false} ShareButton={FakeShareButton} />)
    const inputs = screen.getAllByPlaceholderText('Ask anything...') as HTMLTextAreaElement[]
    expect(inputs[inputs.length - 1].disabled).toBe(true)
  })

  it('holds the starter list until the fetch resolves, and never paints a hardcoded fallback', async () => {
    let resolveQuestions!: (q: string[]) => void
    vi.mocked(fetchSampleQuestionsCached).mockImplementation(
      () => new Promise<string[]>((resolve) => { resolveQuestions = resolve }),
    )
    render(<ChatContainer snowflakeToken="" connected ShareButton={FakeShareButton} />)
    expect(screen.queryByText('What are my top 10 customers by revenue?')).toBeNull()
    expect(document.querySelector('.starter-list')).toBeNull()

    await act(async () => { resolveQuestions(['Profit by region?']) })
    await waitFor(() => expect(screen.getByText('Profit by region?')).toBeTruthy())
    expect(screen.queryByText('What are my top 10 customers by revenue?')).toBeNull()
  })

  it('stays greeting-only when the agent has no sample questions', async () => {
    vi.mocked(fetchSampleQuestionsCached).mockResolvedValue([])
    render(<ChatContainer snowflakeToken="" connected ShareButton={FakeShareButton} />)
    await waitFor(() => expect(fetchSampleQuestionsCached).toHaveBeenCalled())
    expect(document.querySelector('.starter-list')).toBeNull()
    expect(screen.queryByText('What are my top 10 customers by revenue?')).toBeNull()
  })

  it('swaps the starter questions when the agent changes', async () => {
    vi.mocked(fetchSampleQuestionsCached).mockImplementation((_t: string, fqn: string) =>
      Promise.resolve(fqn === 'DB.SCHEMA.AGENT' ? ['Profit by region?'] : ['Stock on hand?'])
    )
    render(<ChatContainer snowflakeToken="" connected ShareButton={FakeShareButton} />)
    await waitFor(() => expect(screen.getByText('Profit by region?')).toBeTruthy())

    act(() => useChatStore.getState().setActiveAgent('DB.SCHEMA.OTHER'))
    await waitFor(() => expect(screen.getByText('Stock on hand?')).toBeTruthy())
    expect(screen.queryByText('Profit by region?')).toBeNull()
  })

  it('follows the stream by scrolling its own list, never scrollIntoView', async () => {
    // scrollIntoView walks every ancestor scrolling box - including the host document's,
    // outside this iframe - which dragged the whole Lightning record page down on each chunk.
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView

    try {
      render(<ChatContainer snowflakeToken="" connected ShareButton={FakeShareButton} />)
      await send('Which region had the highest profit?')
      await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})

describe('ChatContainer streaming lifecycle (Phase 6)', () => {
  beforeEach(() => {
    stream.mockClear()
    vi.mocked(describeThread).mockReset()
    useChatStore.setState({ openThreads: {}, activeThreadTempId: null, threadSummaries: [] })
    useChatStore.getState().newThread('DB.SCHEMA.AGENT')
  })

  it('adds a beforeunload listener while the active thread is streaming, removes it once done', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const tempId = useChatStore.getState().activeThreadTempId!

    render(<ChatContainer snowflakeToken="t" connected ShareButton={FakeShareButton} />)
    expect(addSpy).not.toHaveBeenCalledWith('beforeunload', expect.anything())

    act(() => { useChatStore.getState().setStreaming(tempId, true) })
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))

    act(() => { useChatStore.getState().setStreaming(tempId, false) })
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))
  })

  it('wires "Refresh this thread" to re-fetch and hydrate the active thread', async () => {
    const tempId = useChatStore.getState().activeThreadTempId!
    useChatStore.getState().reconcileThreadId(tempId, 77)
    useChatStore.getState().appendTurn(tempId, {
      id: 'a1', role: 'assistant', text: '', steps: [], citations: [], artifacts: [],
      status: 'error', interrupted: true,
    })
    vi.mocked(describeThread).mockResolvedValue({
      thread_id: 77,
      messages: [{
        message_id: 1, role: 'assistant',
        message_payload: { content: [{ type: 'text', text: 'recovered answer' }] },
      }],
    })

    render(<ChatContainer snowflakeToken="t" connected ShareButton={FakeShareButton} />)
    await userEvent.click(screen.getByRole('button', { name: 'Refresh this thread' }))

    await waitFor(() => {
      const turns = useChatStore.getState().openThreads[tempId].turns
      expect(turns[0]?.text).toBe('recovered answer')
    })
  })
})

describe('ChatContainer editing & forking (Phase 8)', () => {
  beforeEach(() => {
    stream.mockClear()
    useChatStore.setState({ openThreads: {}, activeThreadTempId: null, threadSummaries: [] })
    const tempId = useChatStore.getState().newThread('DB.SCHEMA.AGENT')
    useChatStore.getState().reconcileThreadId(tempId, 9)
    useChatStore.getState().appendTurn(tempId, {
      id: 'u1', role: 'user', text: 'first question', steps: [], citations: [], artifacts: [], status: 'done',
    })
    useChatStore.getState().appendTurn(tempId, {
      id: 'a1', role: 'assistant', text: 'first answer', messageId: 100, steps: [], citations: [], artifacts: [], status: 'done',
    })
  })

  it('editing the user turn forks the thread, keeps the turn count right, and re-streams the edited text', async () => {
    const tempId = useChatStore.getState().activeThreadTempId!
    render(<ChatContainer snowflakeToken="t" connected ShareButton={FakeShareButton} />)

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const textarea = screen.getByDisplayValue('first question')
    fireEvent.change(textarea, { target: { value: 'edited question' } })
    await userEvent.click(screen.getByRole('button', { name: 'Save & resend' }))

    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      tempId, query: 'edited question', threadId: 9, parentMessageId: undefined,
    }))
    const turns = useChatStore.getState().openThreads[tempId].turns
    expect(turns.map((t) => t.text)).toEqual(['edited question'])
    expect(useChatStore.getState().openThreads[tempId].forks?.[ROOT_FORK_KEY]?.map((t) => t.id)).toEqual(['u1', 'a1'])
  })

  it('regenerating the assistant turn forks it without duplicating the user turn', async () => {
    const tempId = useChatStore.getState().activeThreadTempId!
    render(<ChatContainer snowflakeToken="t" connected ShareButton={FakeShareButton} />)

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }))

    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      tempId, query: 'first question', threadId: 9, parentMessageId: undefined,
    }))
    const turns = useChatStore.getState().openThreads[tempId].turns
    expect(turns.map((t) => t.id)).toEqual(['u1'])
    expect(useChatStore.getState().openThreads[tempId].forks?.u1?.map((t) => t.id)).toEqual(['a1'])
  })

  it('shows a fork switcher after a regenerate, and switching restores the displaced branch', async () => {
    const tempId = useChatStore.getState().activeThreadTempId!
    render(<ChatContainer snowflakeToken="t" connected ShareButton={FakeShareButton} />)
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }))

    await userEvent.click(screen.getByRole('button', { name: /Switch to other response/ }))
    const turns = useChatStore.getState().openThreads[tempId].turns
    expect(turns.map((t) => t.id)).toEqual(['u1', 'a1'])
  })
})

describe('ChatContainer accessibility (Phase 13)', () => {
  beforeEach(() => {
    stream.mockClear()
    useChatStore.setState({ openThreads: {}, activeThreadTempId: null, threadSummaries: [] })
    useChatStore.getState().newThread('DB.SCHEMA.AGENT')
  })

  it('exposes the message list as a polite, non-atomic live region', () => {
    render(<ChatContainer snowflakeToken="t" connected ShareButton={FakeShareButton} />)
    const log = screen.getByRole('log', { name: 'Conversation' })
    expect(log.getAttribute('aria-live')).toBe('polite')
    expect(log.getAttribute('aria-atomic')).toBe('false')
  })
})

describe('ChatContainer skill preamble', () => {
  beforeEach(() => {
    stream.mockClear()
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: true, webSearch: false, richComposer: false, nativeStreamFlags: false })
    useChatStore.setState({ openThreads: {}, activeThreadTempId: null, threadSummaries: [] })
    useChatStore.getState().newThread('DB.SCHEMA.AGENT')
  })

  afterEach(() => { resetFeatureFlags() })

  it('folds a selected skill into the outgoing query as a one-shot preamble, not repeated on the next turn', async () => {
    vi.mocked(fetchAgentDetailsCached).mockResolvedValue({
      sampleQuestions: [], tools: [], dataSources: [],
      skills: [{ name: 'review_analyst', stagePath: '@DB.SCH.SKILLS/review_analyst' }],
    })

    render(<ChatContainer snowflakeToken="t" connected ShareButton={FakeShareButton} />)

    const menuButtons = screen.getAllByTitle('Skills')
    fireEvent.click(menuButtons[menuButtons.length - 1])
    fireEvent.click(screen.getByText('Skills'))
    await waitFor(() => screen.getByText('review_analyst'))
    fireEvent.click(screen.getByText('review_analyst'))

    await send('How are reviews trending?')
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
    const first = stream.mock.calls[0][0]
    expect(first.query).toContain('Use the "review_analyst" skill to help with this request.')
    expect(first.query).toMatch(/How are reviews trending\?$/)

    // The transcript keeps only what the user typed - not the skill instructions.
    const turns = useChatStore.getState().openThreads[first.tempId].turns
    expect(turns[0].text).toBe('How are reviews trending?')

    // Attaching a skill is a one-shot action - it's cleared after send and not
    // auto-resent on a later turn the way the date/context preamble is.
    await send('And last month?')
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(2))
    expect(stream.mock.calls[1][0].query).not.toContain('review_analyst')
  })
})

describe('ChatContainer thread creation', () => {
  beforeEach(() => {
    stream.mockClear()
    useChatStore.setState({ openThreads: {}, activeThreadTempId: null, threadSummaries: [] })
    useChatStore.getState().newThread('DB.SCHEMA.AGENT')
  })

  it('upserts the new thread with real timestamps as soon as it is created, not just after the title lands', async () => {
    render(<ChatContainer snowflakeToken="t" connected ShareButton={FakeShareButton} />)
    await send('Which region had the highest profit?')

    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
    // Bug 1 ("Undated" history): before this fix, upsertSummary was only ever called from
    // the async auto-title callback with no created_at/updated_at, so a freshly created
    // thread sat undated until the next full listThreads(). It must land in threadSummaries
    // immediately, with the timestamps createThread() returned.
    const summary = useChatStore.getState().threadSummaries.find((t) => t.thread_id === 11)
    expect(summary).toBeDefined()
    expect(summary?.created_at).toBe('2026-09-01T12:00:00.000Z')
    expect(summary?.updated_at).toBe('2026-09-01T12:00:00.000Z')
  })
})
