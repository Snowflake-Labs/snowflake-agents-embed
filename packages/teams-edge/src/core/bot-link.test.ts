// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeJti, getLinkedToken, linkKey, mintLinkCode, openLinkCode, saveLink, openLink, sealLinkLegacy, type KvLike,
} from './bot-link'

const SECRET = 'bot-link-secret-bot-link-secret-00'
const OBO = { AZURE_TENANT_ID: 't1', OBO_CLIENT_ID: 'c', OBO_CLIENT_SECRET: 's', SNOWFLAKE_SCOPE: 'api://sf/session:role-any' }

function memKv(): KvLike & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v) },
    delete: async (k) => { store.delete(k) },
  }
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
afterEach(() => vi.unstubAllGlobals())

describe('link codes', () => {
  it('round-trips the identity and rejects a different secret', async () => {
    const code = await mintLinkCode('t1', 'o1', SECRET)
    expect(await openLinkCode(code, SECRET)).toMatchObject({ tid: 't1', oid: 'o1' })
    expect(await openLinkCode(code, 'another-secret-another-secret-0000')).toBeNull()
    expect(await openLinkCode('junk', SECRET)).toBeNull()
  })

  it('is one-time', async () => {
    const kv = memKv()
    expect(await consumeJti(kv, 'j1')).toBe(true)
    expect(await consumeJti(kv, 'j1')).toBe(false)
  })

  it('rejects a second consume of the same jti in the same isolate even if KV is slow', async () => {
    const store = new Map<string, string>()
    const kv: KvLike = {
      get: async (k) => {
        await new Promise((r) => setTimeout(r, 20))
        return store.get(k) ?? null
      },
      put: async (k, v) => {
        await new Promise((r) => setTimeout(r, 20))
        store.set(k, v)
      },
      delete: async (k) => { store.delete(k) },
    }
    const [a, b] = await Promise.all([consumeJti(kv, 'concurrent'), consumeJti(kv, 'concurrent')])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('does not accept a stored link as a code', async () => {
    const kv = memKv()
    await saveLink(kv, 't1', 'o1', { rt: 'r', at: 'a', atExp: 1 }, SECRET)
    expect(await openLinkCode(kv.store.get(linkKey('t1', 'o1'))!, SECRET)).toBeNull()
  })
})

describe('getLinkedToken', () => {
  const NOW = 1_000_000

  it('is unlinked when nothing is stored', async () => {
    expect(await getLinkedToken(memKv(), 't1', 'o1', SECRET, OBO, NOW)).toEqual({ linked: false })
  })

  it('returns the cached token without calling Entra while it is fresh', async () => {
    const kv = memKv()
    await saveLink(kv, 't1', 'o1', { rt: 'r', at: 'cached', atExp: NOW + 3000 }, SECRET)
    expect(await getLinkedToken(kv, 't1', 'o1', SECRET, OBO, NOW)).toEqual({ linked: true, token: 'cached' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refreshes near expiry and stores the rotated refresh token', async () => {
    const kv = memKv()
    await saveLink(kv, 't1', 'o1', { rt: 'old-rt', at: 'stale', atExp: NOW + 10 }, SECRET)
    vi.mocked(fetch).mockResolvedValue(Response.json({
      access_token: 'fresh', refresh_token: 'new-rt', expires_in: 3600, scope: OBO.SNOWFLAKE_SCOPE,
    }))
    expect(await getLinkedToken(kv, 't1', 'o1', SECRET, OBO, NOW)).toEqual({ linked: true, token: 'fresh' })
    const sent = new URLSearchParams(((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body) as string)
    expect(sent.get('grant_type')).toBe('refresh_token')
    expect(sent.get('refresh_token')).toBe('old-rt')
    expect(await openLink(kv.store.get(linkKey('t1', 'o1'))!, SECRET, 't1', 'o1')).toMatchObject({ rt: 'new-rt', at: 'fresh', atExp: NOW + 3600 })
  })

  it('unlinks on invalid_grant', async () => {
    const kv = memKv()
    await saveLink(kv, 't1', 'o1', { rt: 'r', at: 'stale', atExp: NOW }, SECRET)
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: 'invalid_grant' }, { status: 400 }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await getLinkedToken(kv, 't1', 'o1', SECRET, OBO, NOW)).toEqual({ linked: false })
    expect(kv.store.has(linkKey('t1', 'o1'))).toBe(false)
  })

  it('keeps the link and throws on a transient Entra failure', async () => {
    const kv = memKv()
    await saveLink(kv, 't1', 'o1', { rt: 'r', at: 'stale', atExp: NOW }, SECRET)
    vi.mocked(fetch).mockResolvedValue(new Response('busy', { status: 503 }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(getLinkedToken(kv, 't1', 'o1', SECRET, OBO, NOW)).rejects.toBeTruthy()
    expect(kv.store.has(linkKey('t1', 'o1'))).toBe(true)
  })

  it('opens a legacy SHA-256 record and re-seals it with HKDF', async () => {
    const kv = memKv()
    const legacy = await sealLinkLegacy({ rt: 'r', at: 'cached', atExp: NOW + 3000 }, SECRET)
    await kv.put(linkKey('t1', 'o1'), legacy)
    expect(await getLinkedToken(kv, 't1', 'o1', SECRET, OBO, NOW)).toEqual({ linked: true, token: 'cached' })
    const resealed = kv.store.get(linkKey('t1', 'o1'))!
    expect(resealed).not.toBe(legacy)
    expect(await openLink(resealed, SECRET, 't1', 'o1')).toMatchObject({ rt: 'r', at: 'cached' })
    expect(await openLink(resealed, SECRET, 'other-tid', 'o1')).toBeNull()
  })

  it('rejects a record opened under the wrong tid or oid', async () => {
    const kv = memKv()
    await saveLink(kv, 't1', 'o1', { rt: 'r', at: 'cached', atExp: NOW + 3000 }, SECRET)
    const sealed = kv.store.get(linkKey('t1', 'o1'))!
    expect(await openLink(sealed, SECRET, 't2', 'o1')).toBeNull()
    expect(await openLink(sealed, SECRET, 't1', 'o2')).toBeNull()
  })
})
