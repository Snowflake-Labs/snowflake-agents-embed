// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { generateKeyPair, SignJWT, type KeyLike } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Real jwtVerify, local key instead of the remote JWKS. Bot Connector tokens carry no `iat`;
// the mocked-jwtVerify tests cannot catch options (e.g. maxTokenAge) that reject such tokens.
const keys = vi.hoisted(() => ({ pub: undefined as unknown }))
vi.mock('jose', async (orig) => {
  const actual = await orig<typeof import('jose')>()
  return { ...actual, createRemoteJWKSet: vi.fn(() => async () => keys.pub) }
})

import { verifyBotRequest } from './bot-link'

const APP = 'e23b6c39-f511-4953-8da1-92ce39b4ea8f'
const ISSUER = 'https://api.botframework.com'
const SERVICE_URL = 'https://smba.trafficmanager.net/teams/'
const ACTIVITY = { serviceUrl: SERVICE_URL, from: { aadObjectId: 'o1' }, channelData: { tenant: { id: 't1' } } }

let priv: KeyLike

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  priv = pair.privateKey
  keys.pub = pair.publicKey
})

afterEach(() => vi.restoreAllMocks())

function mint(opts: { aud?: string; iss?: string; exp?: string | number } = {}) {
  return new SignJWT({ serviceurl: SERVICE_URL })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? APP)
    .setNotBefore('0s')
    .setExpirationTime(opts.exp ?? '1h')
    .sign(priv)
}

describe('verifyBotRequest with a real signed token', () => {
  it('accepts a Bot Connector style token that has no iat claim', async () => {
    expect(await verifyBotRequest(`Bearer ${await mint()}`, APP, ACTIVITY)).toEqual({ tid: 't1', oid: 'o1' })
  })

  it.each([
    ['wrong audience', { aud: 'other-app' }],
    ['wrong issuer', { iss: 'https://evil.example' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ])('rejects %s and logs a reason without the token', async (_name, opts) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const token = await mint(opts)
    expect(await verifyBotRequest(`Bearer ${token}`, APP, ACTIVITY)).toBeNull()
    expect(spy).toHaveBeenCalledOnce()
    expect(String(spy.mock.calls[0][0])).toContain('bot request rejected')
    expect(String(spy.mock.calls[0][0])).not.toContain(token)
  })
})
