// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { Config } from '../config.js'

const processActivity = vi.fn()
let assignedOnTurnError: ((ctx: { sendActivity: (text: string) => Promise<void> }, error: Error) => Promise<void>) | undefined

vi.mock('../bot/handler.js', () => ({
  createBotAdapter: () => {
    const adapter: {
      processActivity: typeof processActivity
      onTurnError?: typeof assignedOnTurnError
    } = { processActivity }
    Object.defineProperty(adapter, 'onTurnError', {
      set(fn: typeof assignedOnTurnError) { assignedOnTurnError = fn },
      get() { return assignedOnTurnError },
    })
    return adapter
  },
  AgentsEmbedBot: class {
    run() { return Promise.resolve() }
  },
}))

import { registerBotRoutes } from './bot.js'
import { REQUEST_AUTH_KEY, type RequestAuth } from '../bot/request-auth.js'

function testConfig(): Config {
  return {
    authMode: 'local-pat',
    host: '127.0.0.1',
    snowflakeAccount: 'testacct',
    botAppId: 'test-bot-app-id',
    botAppSecret: 'test-bot-app-secret',
    port: 3000,
    oboClientId: '',
    oboClientSecret: '',
    snowflakeScope: '',
    defaultAgentFqn: '',
    teamsAppId: '',
    allowedOrigins: ['http://localhost:5173'],
    agentAllowList: [],
    agentDiscovery: 'dynamic',
    botStateTable: 'TEST_DB.TEST_SCH.BOT_STATE',
    featureFlags: {
      fileUpload: false, deepResearch: false, skills: false,
      webSearch: false, richComposer: false, nativeStreamFlags: false,
    },
  }
}

function app() {
  const hono = new Hono()
  registerBotRoutes(hono, testConfig())
  return hono
}

beforeEach(() => {
  vi.clearAllMocks()
  assignedOnTurnError = undefined
  processActivity.mockImplementation(async (_req: unknown, res: { status: (code: number) => { send: (body?: unknown) => void } }) => {
    res.status(200).send('')
  })
})

describe('registerBotRoutes', () => {
  it('logs X-Bot-Auth presence and the Authorization scheme, never header material', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logs.push(String(msg)) })

    await app().request('/api/bot/messages', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer leaked-pat-token-abcdef',
        'X-Bot-Auth': 'Bearer leaked-jwt-xyz',
        'Content-Type': 'application/json',
      },
      body: '{}',
    })

    spy.mockRestore()
    const joined = logs.join('\n')
    expect(joined).toContain('x-bot-auth=present')
    expect(joined).toContain('authorization-scheme=Bearer')
    expect(joined).not.toContain('leaked-pat-token')
    expect(joined).not.toContain('leaked-jwt')
    expect(joined).not.toContain('abcdef')
  })

  it('returns a generic 500 and logs a redacted error when processActivity rejects', async () => {
    processActivity.mockRejectedValue(new Error('JWT eyJhbGciOi secret-material'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await app().request('/api/bot/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
    const logged = errSpy.mock.calls.find((c) => c[0] === '[bot] processActivity error')
    expect(logged?.[1]).toMatchObject({ message: expect.stringContaining('secret-material') })
    expect(JSON.stringify(logged?.[1])).not.toContain('payload')
    errSpy.mockRestore()
  })

  it('installs onTurnError that tells the user to retry and does not rethrow', async () => {
    await app().request('/api/bot/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(assignedOnTurnError).toEqual(expect.any(Function))
    const sendActivity = vi.fn().mockResolvedValue(undefined)
    await expect(assignedOnTurnError!({ sendActivity }, new Error('boom'))).resolves.toBeUndefined()
    expect(sendActivity).toHaveBeenCalledWith('Something went wrong handling that — try again.')
  })

  it('replaces a 4xx adapter body with a generic error', async () => {
    processActivity.mockImplementation(async (_req: unknown, res: { status: (code: number) => { send: (body?: unknown) => void } }) => {
      res.status(401).send('JWT eyJhbGciOi leaked-claims')
    })
    const res = await app().request('/api/bot/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
  })

  it('hands the edge-injected token and link code to the turn, and emits X-Unlink when the handler asks', async () => {
    let seen: RequestAuth | undefined
    processActivity.mockImplementation(async (_req: unknown, res: any, logic: (ctx: any) => Promise<void>) => {
      const turnState = new Map<unknown, unknown>()
      await logic({ turnState })
      seen = turnState.get(REQUEST_AUTH_KEY) as RequestAuth
      seen.unlink = true
      res.status(200).send('')
    })

    const res = await app().request('/api/bot/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Access-Token': 'sf-tok', 'X-Link-Code': 'code-1' },
      body: '{}',
    })

    expect(seen).toMatchObject({ userToken: 'sf-tok', linkCode: 'code-1' })
    expect(res.headers.get('X-Unlink')).toBe('1')
  })
})
