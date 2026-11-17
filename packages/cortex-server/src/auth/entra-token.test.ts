// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey } from 'jose'
import {
  validateEntraToken,
  parseClientIdList,
  DEFAULT_ALLOWED_CLIENT_IDS,
} from './entra-token'

const TENANT = '11111111-1111-1111-1111-111111111111'
const OBO = '22222222-2222-2222-2222-222222222222'
const TEAMS_CLIENT = DEFAULT_ALLOWED_CLIENT_IDS[0]
const opts = { tenantId: TENANT, oboClientId: OBO }

let privateKey: CryptoKey
let jwks: JWTVerifyGetKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey as CryptoKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  jwks = createLocalJWKSet({ keys: [jwk] })
})

function mint(claims: Record<string, unknown> = {}, over: { iss?: string; aud?: string } = {}) {
  return new SignJWT({ scp: 'access_as_user', azp: TEAMS_CLIENT, oid: 'o', tid: TENANT, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(over.iss ?? `https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setAudience(over.aud ?? OBO)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey)
}

describe('validateEntraToken', () => {
  it('accepts a well-formed Teams SSO token', async () => {
    const p = await validateEntraToken(await mint(), jwks, opts)
    expect(p.oid).toBe('o')
  })

  it('accepts the v1 appid claim in place of azp', async () => {
    const t = await mint({ azp: undefined, appid: TEAMS_CLIENT })
    await expect(validateEntraToken(t, jwks, opts)).resolves.toBeTruthy()
  })

  it('rejects a token without the required scope', async () => {
    await expect(validateEntraToken(await mint({ scp: 'other' }), jwks, opts)).rejects.toThrow()
  })

  it('rejects a token with no scp at all', async () => {
    await expect(validateEntraToken(await mint({ scp: undefined }), jwks, opts)).rejects.toThrow()
  })

  it('rejects an azp outside the allow-list', async () => {
    await expect(validateEntraToken(await mint({ azp: 'evil-client' }), jwks, opts)).rejects.toThrow()
  })

  it('honours a custom allow-list', async () => {
    const t = await mint({ azp: 'custom-client' })
    await expect(
      validateEntraToken(t, jwks, { ...opts, allowedClientIds: ['custom-client'] }),
    ).resolves.toBeTruthy()
  })

  it('rejects the wrong audience', async () => {
    await expect(validateEntraToken(await mint({}, { aud: 'someone-else' }), jwks, opts)).rejects.toThrow()
  })

  it('rejects a foreign-tenant issuer', async () => {
    const t = await mint({}, { iss: 'https://login.microsoftonline.com/other/v2.0' })
    await expect(validateEntraToken(t, jwks, opts)).rejects.toThrow()
  })

  it('accepts an explicit audienceUri', async () => {
    const t = await mint({}, { aud: 'api://tab.example/' + OBO })
    await expect(
      validateEntraToken(t, jwks, { ...opts, audienceUri: 'api://tab.example/' + OBO }),
    ).resolves.toBeTruthy()
  })
})

describe('parseClientIdList', () => {
  it('splits, trims and drops blanks; undefined for empty', () => {
    expect(parseClientIdList(' a, b ,,c')).toEqual(['a', 'b', 'c'])
    expect(parseClientIdList('')).toBeUndefined()
    expect(parseClientIdList(undefined)).toBeUndefined()
  })
})
