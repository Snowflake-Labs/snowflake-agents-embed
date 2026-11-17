// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { openEdgeSession } from './edge-session'

const TENANT = '11111111-1111-1111-1111-111111111111'
const OBO = '22222222-2222-2222-2222-222222222222'
const TEAMS = '1fec8e78-bce4-4aaf-ab1b-5451cc387264'

let privateKey: CryptoKey
let jwk: Record<string, unknown>

vi.mock('jose', async (orig) => {
  const actual = await orig<typeof import('jose')>()
  return { ...actual, createRemoteJWKSet: () => actual.createLocalJWKSet({ keys: [jwk as any] }) }
})

const env = {
  AZURE_TENANT_ID: TENANT,
  OBO_CLIENT_ID: OBO,
  OBO_CLIENT_SECRET: 's',
  SNOWFLAKE_SCOPE: 'api://sf/session:role-any',
  EDGE_SESSION_SECRET: 'test-secret-test-secret-test-secret',
}

function mint(claims: Record<string, unknown> = {}) {
  return new SignJWT({ scp: 'access_as_user', azp: TEAMS, oid: 'o1', tid: TENANT, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setAudience(OBO)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey)
}

async function call(entraToken: string, ip = '1.1.1.1') {
  const { onRequestPost } = await import('./exchange')
  const request = new Request('https://tab.example/token/exchange', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entraToken }),
  })
  return (onRequestPost as any)({ request, env })
}

beforeEach(async () => {
  if (!privateKey) {
    const pair = await generateKeyPair('RS256')
    privateKey = pair.privateKey as CryptoKey
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k', alg: 'RS256' }
  }
  vi.resetModules()
  vi.stubGlobal('fetch', vi.fn(async () =>
    Response.json({ access_token: 'sf', expires_in: 3600, scope: env.SNOWFLAKE_SCOPE })))
})

describe('/token/exchange', () => {
  it('exchanges a valid token and returns an edge session', async () => {
    const res = await call(await mint())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.snowflakeToken).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('"sf"')
    expect(await openEdgeSession(body.edgeSession, 'test-secret-test-secret-test-secret')).toMatchObject({ snowflakeToken: 'sf' })
    expect(body.edgeSession).toBeTruthy()
  })

  it('rejects a token missing the access_as_user scope without calling OBO', async () => {
    const res = await call(await mint({ scp: 'other' }))
    expect(res.status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects an azp outside the Teams allow-list', async () => {
    const res = await call(await mint({ azp: 'evil' }))
    expect(res.status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rate-limits per identity with Retry-After', async () => {
    const t = await mint()
    let last: Response | undefined
    for (let i = 0; i < 11; i++) last = await call(t, `9.9.9.${i}`)
    expect(last!.status).toBe(429)
    expect(Number(last!.headers.get('Retry-After'))).toBeGreaterThan(0)
  })

  it('rate-limits per IP before doing any validation', async () => {
    let last: Response | undefined
    for (let i = 0; i < 31; i++) last = await call('junk', '8.8.8.8')
    expect(last!.status).toBe(429)
  })
})
