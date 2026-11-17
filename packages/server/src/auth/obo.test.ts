// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'

describe('exchangeOnBehalfOf', () => {
  it('calls Microsoft token endpoint with on_behalf_of grant and Snowflake scope', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'sf-aud-token', expires_in: 3600, scope: 'api://sf-app/SESSION:ROLE-ANY' }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { exchangeOnBehalfOf } = await import('./obo.js')
    const result = await exchangeOnBehalfOf('teams-entra-jwt', {
      tenantId: 't1', oboClientId: 'c1', oboClientSecret: 's1',
      snowflakeScope: 'api://sf-app/SESSION:ROLE-ANY',
    } as any, { oid: 'user-1' })

    expect(result.snowflakeToken).toBe('sf-aud-token')
    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body)
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(body.get('requested_token_use')).toBe('on_behalf_of')
    expect(body.get('assertion')).toBe('teams-entra-jwt')
    expect(body.get('scope')).toBe('api://sf-app/SESSION:ROLE-ANY')
    expect(mockFetch.mock.calls[0][0]).toContain('login.microsoftonline.com/t1/oauth2/v2.0/token')
  })

  it('rejects a 2xx response that omits access_token or the requested scope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ expires_in: 3600, scope: 'something.else' }),
    }))
    const { exchangeOnBehalfOf } = await import('./obo.js')
    await expect(exchangeOnBehalfOf('jwt', {
      tenantId: 't1', oboClientId: 'c1', oboClientSecret: 's1',
      snowflakeScope: 'api://sf-app/SESSION:ROLE-ANY',
    } as any, { oid: 'user-1' })).rejects.toThrow(/access_token/)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'tok', expires_in: 3600, scope: 'other' }),
    }))
    await expect(exchangeOnBehalfOf('jwt', {
      tenantId: 't1', oboClientId: 'c1', oboClientSecret: 's1',
      snowflakeScope: 'api://sf-app/SESSION:ROLE-ANY',
    } as any, { oid: 'user-1' })).rejects.toThrow(/scope/)
  })

  it('refuses to POST when the caller did not supply a verified Entra payload', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    const { exchangeOnBehalfOf } = await import('./obo.js')
    await expect(exchangeOnBehalfOf('jwt', {
      tenantId: 't1', oboClientId: 'c1', oboClientSecret: 's1',
      snowflakeScope: 'api://sf-app/SESSION:ROLE-ANY',
    } as any, undefined as any)).rejects.toThrow(/verified Entra payload/)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
