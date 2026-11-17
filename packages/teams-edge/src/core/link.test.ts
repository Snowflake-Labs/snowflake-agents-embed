// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { linkKey, mintLinkCode, openLink, type KvLike } from './bot-link'

const TENANT = '11111111-1111-1111-1111-111111111111'
const OBO = '22222222-2222-2222-2222-222222222222'
const TEAMS = '1fec8e78-bce4-4aaf-ab1b-5451cc387264'
const SECRET = 'bot-link-secret-bot-link-secret-00'

let privateKey: CryptoKey
let jwk: Record<string, unknown>

vi.mock('jose', async (orig) => {
  const actual = await orig<typeof import('jose')>()
  return { ...actual, createRemoteJWKSet: () => actual.createLocalJWKSet({ keys: [jwk as any] }) }
})

function memKv(): KvLike & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v) },
    delete: async (k) => { store.delete(k) },
  }
}

let kv: ReturnType<typeof memKv>
const env = () => ({
  AZURE_TENANT_ID: TENANT, OBO_CLIENT_ID: OBO, OBO_CLIENT_SECRET: 's',
  SNOWFLAKE_SCOPE: 'api://sf/session:role-any', BOT_LINK_SECRET: SECRET, BOT_LINKS: kv,
})

function mint(claims: Record<string, unknown> = {}) {
  return new SignJWT({ scp: 'access_as_user', azp: TEAMS, oid: 'o1', tid: TENANT, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setAudience(OBO)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey)
}

async function call(code: string, entraToken: string, ip = '1.1.1.1') {
  const { onRequestPost } = await import('./link')
  const request = new Request('https://tab.example/token/link', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, entraToken }),
  })
  return (onRequestPost as any)({ request, env: env() }) as Promise<Response>
}

beforeEach(async () => {
  if (!privateKey) {
    const pair = await generateKeyPair('RS256')
    privateKey = pair.privateKey as CryptoKey
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k', alg: 'RS256' }
  }
  kv = memKv()
  vi.resetModules()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () =>
    Response.json({ access_token: 'sf', refresh_token: 'rt', expires_in: 3600, scope: 'api://sf/session:role-any offline_access' })))
})

describe('/token/link', () => {
  it('links the user: stores the encrypted refresh token and returns no credential', async () => {
    const res = await call(await mintLinkCode(TENANT, 'o1', SECRET), await mint())
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('rt')
    const stored = await openLink(kv.store.get(linkKey(TENANT, 'o1'))!, SECRET, TENANT, 'o1')
    expect(stored).toMatchObject({ rt: 'rt', at: 'sf' })
    const sent = new URLSearchParams(((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body) as string)
    expect(sent.get('scope')).toContain('offline_access')
  })

  it('rejects a code issued to a different user without calling OBO', async () => {
    const res = await call(await mintLinkCode(TENANT, 'someone-else', SECRET), await mint())
    expect(res.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
    expect(kv.store.size).toBe(0)
  })

  it('rejects a replayed code', async () => {
    const code = await mintLinkCode(TENANT, 'o1', SECRET)
    expect((await call(code, await mint())).status).toBe(200)
    expect((await call(code, await mint())).status).toBe(409)
  })

  it('rejects a garbage code', async () => {
    expect((await call('junk', await mint())).status).toBe(400)
  })

  it('fails without storing anything when Entra returns no refresh token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({ access_token: 'sf', expires_in: 3600, scope: 'api://sf/session:role-any' })))
    const res = await call(await mintLinkCode(TENANT, 'o1', SECRET), await mint())
    expect(res.status).toBe(502)
    expect(kv.store.has(linkKey(TENANT, 'o1'))).toBe(false)
  })
})
