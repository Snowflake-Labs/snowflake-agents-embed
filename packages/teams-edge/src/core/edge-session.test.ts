// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { EncryptJWT, SignJWT } from 'jose'
import { edgeSessionTtlS, openEdgeSession, signEdgeSession } from './edge-session'

const SECRET = 'test-secret-test-secret-test-secret'
const CLAIMS = { tid: 't', oid: 'o', snowflakeToken: 'sf-token-value' }

describe('edge session', () => {
  it('round-trips claims including the Snowflake token', async () => {
    const token = await signEdgeSession(CLAIMS, SECRET)
    expect(await openEdgeSession(token, SECRET)).toEqual(CLAIMS)
  })

  it('does not expose the Snowflake token to the holder', async () => {
    const token = await signEdgeSession(CLAIMS, SECRET)
    expect(token).not.toContain('sf-token-value')
    for (const part of token.split('.')) {
      expect(Buffer.from(part, 'base64url').toString('utf8')).not.toContain('sf-token-value')
    }
  })

  it('rejects a session encrypted with another secret', async () => {
    const token = await signEdgeSession(CLAIMS, 'other-secret-other-secret-other-secret')
    expect(await openEdgeSession(token, SECRET)).toBeNull()
  })

  it('rejects garbage and empty tokens', async () => {
    expect(await openEdgeSession('junk', SECRET)).toBeNull()
    expect(await openEdgeSession('', SECRET)).toBeNull()
  })

  it('rejects an expired session', async () => {
    const token = await signEdgeSession(CLAIMS, SECRET, 1)
    await new Promise((r) => setTimeout(r, 2100))
    expect(await openEdgeSession(token, SECRET)).toBeNull()
  })

  it('rejects a signed-only (unencrypted) token', async () => {
    const token = await new SignJWT({ sft: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('agents-embed-teams-edge')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET))
    expect(await openEdgeSession(token, SECRET)).toBeNull()
  })

  it('rejects the wrong issuer', async () => {
    const k = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SECRET)))
    const token = await new EncryptJWT({ sft: 'x' })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuer('someone-else')
      .setExpirationTime('1h')
      .encrypt(k)
    expect(await openEdgeSession(token, SECRET)).toBeNull()
  })

  it('rejects a session with no Snowflake token', async () => {
    const k = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SECRET)))
    const token = await new EncryptJWT({ tid: 't', oid: 'o' })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuer('agents-embed-teams-edge')
      .setExpirationTime('1h')
      .encrypt(k)
    expect(await openEdgeSession(token, SECRET)).toBeNull()
  })

  it('caps the lifetime at an hour and inside the token lifetime', () => {
    expect(edgeSessionTtlS(86_400)).toBe(3600)
    expect(edgeSessionTtlS(600)).toBe(570)
    expect(edgeSessionTtlS(5)).toBe(1)
  })
})

describe('edge session key handling', () => {
  it('refuses a secret shorter than 32 bytes', async () => {
    await expect(signEdgeSession(CLAIMS, 'short')).rejects.toThrow(/32 bytes/)
    expect(await openEdgeSession('junk', 'short')).toBeNull()
  })
})
