// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BOT_TRUNCATION_MARKER, AgentsEmbedBot } from './handler.js'
import type { Config } from '../config.js'

vi.mock('./cortex.js', () => ({
  streamCortexAgent: vi.fn(),
  createCortexThread: vi.fn(),
}))
vi.mock('../lib/bot-state.js', () => ({
  getBotUserState: vi.fn(),
  setBotUserState: vi.fn(),
  clearBotUserState: vi.fn(),
}))

import { streamCortexAgent, createCortexThread } from './cortex.js'
import { signSnapshotParam } from '../lib/share-snapshot.js'
import { getBotUserState, setBotUserState } from '../lib/bot-state.js'
import { REQUEST_AUTH_KEY, type RequestAuth } from './request-auth.js'

function baseConfig(): Config {
  return {
    authMode: 'local-pat',
    host: '127.0.0.1',
    snowflakeAccount: 'acct',
    botAppId: '', botAppSecret: '', port: 3000,
    oboClientId: '', oboClientSecret: '', snowflakeScope: '',
    defaultAgentFqn: 'DB.SCH.AGENT',
    teamsAppId: 'app1',
    shareSigningSecret: 'share-secret',
    allowedOrigins: ['http://localhost:5173'],
    agentAllowList: [],
    agentDiscovery: 'dynamic',
    botStateTable: 'DB.SCH.BOT_STATE',
    featureFlags: { fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false },
  }
}

function fakeCtx(overrides: Partial<{ text: string; value: unknown; auth: Partial<RequestAuth> }> = {}) {
  const turnState = new Map<unknown, unknown>()
  turnState.set(REQUEST_AUTH_KEY, { unlink: false, ...overrides.auth })
  return {
    turnState,
    activity: { from: { id: 'user1' }, text: overrides.text ?? '', value: overrides.value, channelData: {} },
    sendActivity: vi.fn().mockResolvedValue({ id: 'act1' }),
    updateActivity: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SNOWFLAKE_PAT = 'pat-token'
  vi.mocked(getBotUserState).mockResolvedValue({ ok: true, state: null })
  vi.mocked(setBotUserState).mockResolvedValue(true)
  vi.mocked(createCortexThread).mockResolvedValue(undefined)
})

describe('AgentsEmbedBot.callAndReply (Phase 12 streaming)', () => {
  it('posts once as text starts arriving, then updates the same activity at the end', async () => {
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'text.delta', text: 'Hello' }
      yield { kind: 'text.delta', text: ' world' }
      yield { kind: 'final', threadId: 9, messageId: 100 }
    } as any)

    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx()
    await (bot as any).callAndReply(ctx, 'user1', 'hi')

    // typing indicator + the first posted card
    expect(ctx.sendActivity).toHaveBeenCalledTimes(2)
    // the throttled second delta is coalesced into the one forced update at the end
    expect(ctx.updateActivity).toHaveBeenCalledTimes(1)
    const updated = ctx.updateActivity.mock.calls.at(-1)![0]
    const body = updated.attachments[0].content.body as any[]
    expect(body.some((b: any) => b.text === 'Hello world')).toBe(true)
  })

  it('does not persist a thread chain after a call', async () => {
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'text', text: 'answer' }
      yield { kind: 'final', threadId: 9, messageId: 100 }
    } as any)

    const bot = new AgentsEmbedBot(baseConfig())
    await (bot as any).callAndReply(fakeCtx(), 'user1', 'hi')

    expect(setBotUserState).not.toHaveBeenCalled()
  })

  it('renders a chart/table/citations note in the card when the stream produced them', async () => {
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'text', text: 'answer' }
      yield { kind: 'chart', spec: {} }
      yield { kind: 'table', rowType: [{ name: 'A' }], data: [['1']], numRows: 1 }
      yield { kind: 'annotation', citation: { index: 1, docTitle: 'Doc A', url: 'https://a' } }
      yield { kind: 'final', threadId: 9, messageId: 100 }
    } as any)

    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx()
    await (bot as any).callAndReply(ctx, 'user1', 'hi')

    const updated = ctx.updateActivity.mock.calls.at(-1)![0]
    const body = updated.attachments[0].content.body as any[]
    expect(body.some((b: any) => typeof b.text === 'string' && b.text.includes('chart is available'))).toBe(true)
    expect(body.some((b: any) => b.type === 'Table')).toBe(true)
    expect(body.some((b: any) => b.text === '[Doc A](https://a)')).toBe(true)
  })

  it('falls back to an inline error message when the stream throws before any text arrives', async () => {
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      throw new Error('boom')
    } as any)

    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx()
    await (bot as any).callAndReply(ctx, 'user1', 'hi')

    expect(ctx.sendActivity).toHaveBeenCalledTimes(2) // typing + one error
    const msg = ctx.sendActivity.mock.calls.at(-1)![0] as string
    expect(msg).toMatch(/\(ref [0-9a-f]{8}\)/)
    expect(msg).not.toContain('boom')
    expect(ctx.updateActivity).not.toHaveBeenCalled()
  })

  it('does not leak raw upstream error text into an in-place error update', async () => {
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'text.delta', text: 'x' }
      throw new Error('SECRET_DB.SECRET_SCHEMA does not exist')
    } as any)
    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx()
    await (bot as any).callAndReply(ctx, 'user1', 'hi')
    const all = JSON.stringify([...ctx.sendActivity.mock.calls, ...ctx.updateActivity.mock.calls])
    expect(all).not.toContain('SECRET_DB')
  })

  it('does not log query text or agent FQN by default', async () => {
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'final', threadId: 1, messageId: 2 }
    } as any)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const bot = new AgentsEmbedBot(baseConfig())
    await (bot as any).handleMessage(fakeCtx({ text: 'confidential revenue question' }))
    await (bot as any).handleAgentSelect(fakeCtx(), 'user1', 'DB.SCH.NEW_AGENT').catch(() => {})
    const logged = log.mock.calls.flat().join('\n')
    expect(logged).not.toContain('confidential')
    expect(logged).not.toContain('NEW_AGENT')
    log.mockRestore()
  })

  it('includes the question in the card, matching the compose-extension path', async () => {
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'text', text: 'answer' }
      yield { kind: 'final', threadId: 9, messageId: 100 }
    } as any)

    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx()
    await (bot as any).callAndReply(ctx, 'user1', 'What were Q1 sales?')

    const updated = ctx.updateActivity.mock.calls.at(-1)![0]
    const body = updated.attachments[0].content.body as any[]
    expect(body.some((b: any) => typeof b.text === 'string' && b.text.includes('What were Q1 sales?'))).toBe(true)
  })

  it('does not persist when hydration failed, so a failed read cannot blank stored state', async () => {
    vi.mocked(getBotUserState).mockResolvedValue({ ok: false })
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'text', text: 'answer' }
      yield { kind: 'final', threadId: 9, messageId: 100 }
    } as any)

    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx()
    await (bot as any).callAndReply(ctx, 'user1', 'hi')

    expect(setBotUserState).not.toHaveBeenCalled()
    const updated = ctx.updateActivity.mock.calls.at(-1)![0]
    const body = updated.attachments[0].content.body as any[]
    expect(body.some((b: any) => b.text === 'answer')).toBe(true)
  })

  it('posts a fresh card when the forced final update fails twice', async () => {
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'text', text: 'Hello world' }
      yield { kind: 'final', threadId: 9, messageId: 100 }
    } as any)

    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx()
    ctx.updateActivity.mockRejectedValue(new Error('rate limited'))
    await (bot as any).callAndReply(ctx, 'user1', 'hi')

    expect(ctx.updateActivity).toHaveBeenCalledTimes(2)
    expect(ctx.sendActivity).toHaveBeenCalledTimes(3)
    const fallback = ctx.sendActivity.mock.calls.at(-1)![0]
    expect(fallback.attachments).toBeDefined()
    const body = fallback.attachments[0].content.body as any[]
    expect(body.some((b: any) => b.text === 'Hello world')).toBe(true)
  })

  it('appends the incomplete marker when the stream aborts after partial text', async () => {
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'text.delta', text: 'Partial answer' }
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    } as any)

    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx()
    await (bot as any).callAndReply(ctx, 'user1', 'hi')

    const updated = ctx.updateActivity.mock.calls.at(-1)![0]
    const body = updated.attachments[0].content.body as any[]
    expect(body.some((b: any) => typeof b.text === 'string' && b.text.includes('Partial answer'))).toBe(true)
    expect(body.some((b: any) => typeof b.text === 'string' && b.text.includes(BOT_TRUNCATION_MARKER))).toBe(true)
  })

  it('creates a thread for a new conversation and links the card to it', async () => {
    vi.mocked(createCortexThread).mockResolvedValue(42)
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'text', text: 'answer' }
      yield { kind: 'metadata', messageId: 7, role: 'assistant' }
    } as any)

    const ctx = fakeCtx()
    await (new AgentsEmbedBot(baseConfig()) as any).callAndReply(ctx, 'user1', 'hi')

    expect(streamCortexAgent).toHaveBeenCalledWith(expect.objectContaining({ threadId: 42 }))
    const card = ctx.updateActivity.mock.calls.at(-1)![0].attachments[0].content
    expect(decodeURIComponent(card.actions[0].url)).toContain('thread:42')
  })

  it('starts a new thread for every question, ignoring any persisted thread', async () => {
    vi.mocked(getBotUserState).mockResolvedValue({ ok: true, state: { agentFqn: 'DB.SCH.AGENT', threadId: 9, parentMessageId: 100 } })
    vi.mocked(createCortexThread).mockResolvedValueOnce(51).mockResolvedValueOnce(52)
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'text', text: 'answer' }
    } as any)
    const bot = new AgentsEmbedBot(baseConfig())
    await (bot as any).callAndReply(fakeCtx(), 'user1', 'first')
    await (bot as any).callAndReply(fakeCtx(), 'user1', 'second')

    expect(createCortexThread).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(streamCortexAgent).mock.calls.map((c) => c[0])
    expect(calls.map((c) => c.threadId)).toEqual([51, 52])
    expect(calls.every((c) => c.parentMessageId === undefined)).toBe(true)
  })

  const prod = () => new AgentsEmbedBot({ ...baseConfig(), authMode: 'production', teamsAppId: 'app-1' } as any)

  it('sends a sign-in card (once) when the user is not linked, never using the shared PAT', async () => {
    const ctx = fakeCtx({ auth: { linkCode: 'code-123' } })

    await expect((prod() as any).callAndReply(ctx, 'user1', 'hi')).resolves.toBeUndefined()
    expect(ctx.sendActivity).toHaveBeenCalledTimes(1)
    const card = (ctx.sendActivity.mock.calls[0][0] as any).attachments[0].content
    const url = card.actions[0].url as string
    expect(card.actions[0].type).toBe('Action.OpenUrl')
    expect(decodeURIComponent(url)).toContain('signin:code-123')
    expect(streamCortexAgent).not.toHaveBeenCalled()
  })

  it('says sign-in is unavailable when the edge supplied neither token nor code', async () => {
    const ctx = fakeCtx()
    await (prod() as any).callAndReply(ctx, 'user1', 'hi')
    expect(ctx.sendActivity).toHaveBeenCalledTimes(1)
    expect(ctx.sendActivity).toHaveBeenCalledWith(expect.stringContaining('not available'))
    expect(streamCortexAgent).not.toHaveBeenCalled()
  })

  it('calls the agent as the user with an OAUTH credential when linked', async () => {
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'text', text: 'ok' }
      yield { kind: 'final', threadId: 1, messageId: 2 }
    } as any)
    const ctx = fakeCtx({ auth: { userToken: 'user-sf-token' } })

    await (prod() as any).callAndReply(ctx, 'user1', 'hi')
    const args = vi.mocked(streamCortexAgent).mock.calls[0][0] as any
    expect(args.snowflakeToken).toBe('user-sf-token')
    expect(args.tokenType).toBe('OAUTH')
  })

  it('sign out flags the edge to drop the stored link', async () => {
    const ctx = fakeCtx({ auth: { userToken: 'user-sf-token' } })
    await (prod() as any).handleSignOutCommand(ctx)
    expect((ctx.turnState.get(REQUEST_AUTH_KEY) as RequestAuth).unlink).toBe(true)
    expect(ctx.sendActivity).toHaveBeenCalledWith(expect.stringContaining('Signed out'))
  })
})

describe('AgentsEmbedBot.handleMembersAdded', () => {
  it('sends a welcome message and starter-prompts card when the bot itself is added', async () => {
    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = {
      activity: { recipient: { id: 'bot1' }, membersAdded: [{ id: 'bot1' }], channelData: {} },
      sendActivity: vi.fn().mockResolvedValue({ id: 'act1' }),
    }
    await (bot as any).handleMembersAdded(ctx)

    expect(ctx.sendActivity).toHaveBeenCalledWith(expect.stringContaining("I'm **Snowflake Agent for Teams (Unofficial)**"))
  })

  it('does nothing when a different member is added', async () => {
    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = {
      activity: { recipient: { id: 'bot1' }, membersAdded: [{ id: 'someUser' }], channelData: {} },
      sendActivity: vi.fn(),
    }
    await (bot as any).handleMembersAdded(ctx)

    expect(ctx.sendActivity).not.toHaveBeenCalled()
  })
})

describe('AgentsEmbedBot.handleAgentSelect', () => {
  it('persists the newly selected agent with no thread carried over', async () => {
    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx({ value: { selectAgent: 'DB.SCH.NEW_AGENT' } })
    await (bot as any).handleMessage(ctx)

    expect(setBotUserState).toHaveBeenCalledWith('acct', 'pat-token', 'PROGRAMMATIC_ACCESS_TOKEN', 'DB.SCH.BOT_STATE', 'user1', expect.objectContaining({
      agentFqn: 'DB.SCH.NEW_AGENT',
    }))
    expect(ctx.sendActivity).toHaveBeenCalledWith(expect.stringContaining('NEW_AGENT'))
  })

  it('rejects a malformed FQN without persisting anything', async () => {
    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx({ value: { selectAgent: 'not-a-fqn' } })
    await (bot as any).handleMessage(ctx)

    expect(setBotUserState).not.toHaveBeenCalled()
    expect(ctx.sendActivity).toHaveBeenCalledWith(expect.stringContaining('Invalid agent'))
  })

  it.each(['%2e%2e.B.C', 'A.B.C/../D', 'A.B?x.C', 'A.B#x.C', 'A.B.C%2fD'])(
    'rejects an injection-shaped FQN %s without persisting',
    async (fqn) => {
      const bot = new AgentsEmbedBot(baseConfig())
      const ctx = fakeCtx({ value: { selectAgent: fqn } })
      await (bot as any).handleMessage(ctx)

      expect(setBotUserState).not.toHaveBeenCalled()
      expect(ctx.sendActivity).toHaveBeenCalledWith(expect.stringContaining('Invalid agent'))
    },
  )

  it('ignores an invalid persisted FQN and falls back to the default agent', async () => {
    vi.mocked(getBotUserState).mockResolvedValue({ ok: true, state: { agentFqn: '%2e%2e.B.C', threadId: 9, parentMessageId: 100 } })
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'text', text: 'ok' }
      yield { kind: 'final', threadId: 9, messageId: 101 }
    } as any)
    const bot = new AgentsEmbedBot(baseConfig())
    await (bot as any).ensureHydrated('user1', { token: 'pat-token', tokenType: 'PROGRAMMATIC_ACCESS_TOKEN' })
    expect((bot as any).resolveAgent('user1')).toBe('DB.SCH.AGENT')
  })

  it('degrades the confirmation to a session-only notice when the write fails', async () => {
    vi.mocked(setBotUserState).mockResolvedValue(false)
    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx({ value: { selectAgent: 'DB.SCH.NEW_AGENT' } })
    await (bot as any).handleMessage(ctx)

    expect(ctx.sendActivity).toHaveBeenCalledWith(expect.stringContaining("couldn't save it as your default"))
  })
})

describe('AgentsEmbedBot.handleComposeQuery (Phase 14)', () => {
  it('drains the stream to completion and returns a single compose-extension result', async () => {
    vi.mocked(streamCortexAgent).mockImplementation(async function* () {
      yield { kind: 'text.delta', text: 'answer' }
      yield { kind: 'final', threadId: 9, messageId: 100 }
    } as any)

    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx({ value: { parameters: [{ name: 'query', value: 'What were Q1 sales?' }] } })
    const result: any = await (bot as any).onInvokeActivity({ ...ctx, activity: { ...ctx.activity, name: 'composeExtension/query' } })

    expect(result.status).toBe(200)
    const card = result.body.composeExtension.attachments[0]
    const body = card.content.body as any[]
    expect(body.some((b: any) => b.text === 'answer')).toBe(true)
    expect(setBotUserState).not.toHaveBeenCalled()
  })

  it('returns an empty result when the query parameter is missing', async () => {
    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx({ value: { parameters: [] } })
    const result: any = await (bot as any).onInvokeActivity({ ...ctx, activity: { ...ctx.activity, name: 'composeExtension/query' } })

    expect(result.body.composeExtension.attachments).toEqual([])
    expect(streamCortexAgent).not.toHaveBeenCalled()
  })
})

describe('AgentsEmbedBot.handleQueryLink (F10)', () => {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const run = async (url: string) => {
    const bot = new AgentsEmbedBot(baseConfig())
    const ctx = fakeCtx({ value: { url } })
    const r: any = await (bot as any).onInvokeActivity({ ...ctx, activity: { ...ctx.activity, name: 'composeExtension/queryLink' } })
    return r.body.composeExtension.attachments as any[]
  }

  it('renders a card for a correctly signed snapshot', async () => {
    const s = enc({ q: 'Q?', a: 'Real answer', id: 7 })
    const sig = signSnapshotParam(s, 'share-secret')
    const atts = await run(`https://tab.example/?s=${s}&sig=${encodeURIComponent(sig)}`)
    expect(atts).toHaveLength(1)
    expect(JSON.stringify(atts[0])).toContain('Real answer')
  })

  it('renders nothing for an unsigned snapshot', async () => {
    const s = enc({ a: 'phish' })
    expect(await run(`https://tab.example/?s=${s}`)).toEqual([])
  })

  it('renders nothing for a forged signature', async () => {
    const s = enc({ a: 'phish' })
    const sig = signSnapshotParam(s, 'attacker-secret')
    expect(await run(`https://tab.example/?s=${s}&sig=${encodeURIComponent(sig)}`)).toEqual([])
  })
})
