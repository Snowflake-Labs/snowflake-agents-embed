// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exchangeOnBehalfOf, refreshSnowflakeToken, type EntraGrantError } from './obo'

const env = {
  AZURE_TENANT_ID: 'tenant-1',
  OBO_CLIENT_ID: 'client-1',
  OBO_CLIENT_SECRET: 'super-secret-value',
  SNOWFLAKE_SCOPE: 'api://sf/session:role-any',
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const good = { access_token: 'sf-token', expires_in: 3600, scope: 'api://sf/session:role-any' }

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const sentForm = () => new URLSearchParams((fetchMock.mock.calls[0][1] as RequestInit).body as string)

describe('exchangeOnBehalfOf', () => {
  it('posts a jwt-bearer OBO grant to the tenant token endpoint', async () => {
    fetchMock.mockResolvedValue(ok(good))
    const result = await exchangeOnBehalfOf('entra-jwt', env)
    expect(fetchMock.mock.calls[0][0]).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token')
    const form = sentForm()
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(form.get('assertion')).toBe('entra-jwt')
    expect(form.get('requested_token_use')).toBe('on_behalf_of')
    expect(form.get('scope')).toBe(env.SNOWFLAKE_SCOPE)
    expect(result).toEqual({ snowflakeToken: 'sf-token', expiresIn: 3600 })
  })

  it('requests offline_access and returns the refresh token when asked', async () => {
    fetchMock.mockResolvedValue(ok({ ...good, refresh_token: 'rt-1' }))
    const result = await exchangeOnBehalfOf('entra-jwt', env, { offlineAccess: true })
    expect(sentForm().get('scope')).toBe(`${env.SNOWFLAKE_SCOPE} offline_access`)
    expect(result.refreshToken).toBe('rt-1')
  })

  it.each([
    ['missing access_token', { expires_in: 3600, scope: good.scope }],
    ['bad expires_in', { access_token: 't', expires_in: 0, scope: good.scope }],
    ['missing scope grant', { access_token: 't', expires_in: 3600, scope: 'other' }],
  ])('rejects a response with %s', async (_label, body) => {
    fetchMock.mockResolvedValue(ok(body))
    await expect(exchangeOnBehalfOf('entra-jwt', env)).rejects.toThrow()
  })

  it('marks a 4xx grant failure permanent, with the AADSTS code, and never logs the response body', async () => {
    const body = JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS50013: leaked-detail-xyz' })
    fetchMock.mockResolvedValue(new Response(body, { status: 400 }))
    const err = (await exchangeOnBehalfOf('entra-jwt', env).catch((e: unknown) => e)) as EntraGrantError
    expect(err.permanent).toBe(true)
    expect(err.status).toBe(400)
    expect(err.code).toBe('AADSTS50013')
    expect(JSON.stringify((console.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('leaked-detail-xyz')
  })

  it.each([429, 500, 503])('treats HTTP %i as transient', async (status) => {
    fetchMock.mockResolvedValue(new Response('{}', { status }))
    const err = (await exchangeOnBehalfOf('entra-jwt', env).catch((e: unknown) => e)) as EntraGrantError
    expect(err.permanent).toBe(false)
  })
})

describe('refreshSnowflakeToken', () => {
  it('posts a refresh_token grant with offline_access', async () => {
    fetchMock.mockResolvedValue(ok({ ...good, refresh_token: 'rt-2' }))
    await refreshSnowflakeToken('rt-1', env)
    const form = sentForm()
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('rt-1')
    expect(form.get('scope')).toBe(`${env.SNOWFLAKE_SCOPE} offline_access`)
  })
})
