// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import * as microsoftTeams from '@microsoft/teams-js'
import { useTeamsAuth, classifyAuthError, refreshDelayMs } from './useTeamsAuth'
import { TEST_USER_UPN } from '../test/identities'
import { tabHostAdapter } from '../host/hostAdapter'

vi.mock('@microsoft/teams-js', () => ({
  app: {
    initialize: vi.fn().mockResolvedValue(undefined),
    getContext: vi.fn().mockResolvedValue({ user: { displayName: 'Jane Doe' } }),
  },
  authentication: {
    getAuthToken: vi.fn().mockResolvedValue('entra-token'),
  },
}))

// getAuthToken's public typing keeps a deprecated void-returning callback overload, which
// vi.mocked resolves to — reach for the mock through its own type instead.
const getAuthToken = microsoftTeams.authentication.getAuthToken as unknown as Mock<() => Promise<string>>

function fakeJwt(claims: Record<string, unknown>): string {
  const body = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${body}.signature`
}

/** Lets the hook's two async effects (token exchange, Teams context) settle. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(microsoftTeams.app.initialize).mockResolvedValue(undefined)
  vi.mocked(microsoftTeams.app.getContext).mockResolvedValue({ user: { displayName: 'Jane Doe' } } as any)
  getAuthToken.mockResolvedValue('entra-token')
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ snowflakeToken: 'sf-token', expiresIn: 3600, edgeSession: 'edge-sess' }),
  }) as any
  vi.stubEnv('VITE_SPCS_BASE', 'https://spcs.example.app')
  vi.stubEnv('VITE_EDGE_BASE', 'https://edge.example.dev')
  vi.stubEnv('VITE_AUTH_MODE', '')
})

describe('useTeamsAuth', () => {
  it('stores the edge session and sends it on later API calls', async () => {
    renderHook(() => useTeamsAuth())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(tabHostAdapter.headers('sf-token')['X-Edge-Session']).toBe('edge-sess')
  })

  it('exchanges the Entra token against the edge /token/exchange and returns edgeSession', async () => {
    const { result } = renderHook(() => useTeamsAuth())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(result.current.edgeSession).toBe('edge-sess')
    expect(result.current.error).toBeNull()
    expect(global.fetch).toHaveBeenCalledWith(
      'https://edge.example.dev/token/exchange',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('uses a same-origin edge path when VITE_EDGE_BASE is empty', async () => {
    vi.stubEnv('VITE_EDGE_BASE', '')
    const { result } = renderHook(() => useTeamsAuth())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(result.current.edgeSession).toBe('edge-sess')
    const [url] = (global.fetch as any).mock.calls[0]
    expect(url).toBe('/token/exchange')
  })

  it('local-pat mode sends X-Snowflake-Pat to the SPCS/dev-proxy /api/token/exchange', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'local-pat')
    vi.stubEnv('VITE_SPCS_BASE', '')
    vi.stubEnv('VITE_SNOWFLAKE_PAT', 'dev-pat')
    const { result } = renderHook(() => useTeamsAuth())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(result.current.edgeSession).toBe('sf-token')
    const [url, opts] = (global.fetch as any).mock.calls[0]
    expect(url).toBe('/api/token/exchange')
    expect(opts.headers['X-Snowflake-Pat']).toBe('dev-pat')
  })

  it('surfaces the display name from the Teams context in the SSO path', async () => {
    const { result } = renderHook(() => useTeamsAuth())
    await settle()
    expect(result.current.currentUserName).toBe('Jane Doe')
  })

  it('falls back to the Entra token name claim when the context has no displayName', async () => {
    vi.mocked(microsoftTeams.app.getContext).mockResolvedValue({ user: {} } as any)
    getAuthToken.mockResolvedValue(fakeJwt({ name: 'Jane Doe' }))
    const { result } = renderHook(() => useTeamsAuth())
    await settle()
    expect(result.current.currentUserName).toBe('Jane Doe')
  })

  it('falls back to the userPrincipalName when neither displayName nor token claims help', async () => {
    vi.mocked(microsoftTeams.app.getContext)
      .mockResolvedValue({ user: { userPrincipalName: TEST_USER_UPN } } as any)
    getAuthToken.mockResolvedValue('opaque-token')
    const { result } = renderHook(() => useTeamsAuth())
    await settle()
    expect(result.current.currentUserName).toBe('Jane Doe')
  })

  it('resolves the name in local-pat mode too, so a sideloaded dev build still greets', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'local-pat')
    vi.stubEnv('VITE_SPCS_BASE', '')
    vi.stubEnv('VITE_SNOWFLAKE_PAT', 'dev-pat')
    const { result } = renderHook(() => useTeamsAuth())
    await settle()
    expect(result.current.currentUserName).toBe('Jane Doe')
  })

  it('leaves currentUserName undefined outside a Teams host (plain browser dev server)', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'local-pat')
    vi.stubEnv('VITE_SPCS_BASE', '')
    vi.stubEnv('VITE_SNOWFLAKE_PAT', 'dev-pat')
    vi.mocked(microsoftTeams.app.initialize).mockRejectedValue(new Error('no Teams host'))
    const { result } = renderHook(() => useTeamsAuth())
    await settle()
    expect(result.current.currentUserName).toBeUndefined()
    // The token path is unaffected — local-pat never touches the SDK.
    expect(result.current.edgeSession).toBe('sf-token')
  })

  it('classifies a consent-not-granted Entra failure into an actionable message', async () => {
    getAuthToken.mockRejectedValue(new Error('AADSTS65001: The user or administrator has not consented...'))
    const { result } = renderHook(() => useTeamsAuth())
    await settle()
    expect(result.current.error).toMatch(/haven't consented/)
  })

  it('classifies a tenant-misconfiguration Entra failure into an actionable message', async () => {
    getAuthToken.mockRejectedValue(new Error('AADSTS700016: Application not found in the directory'))
    const { result } = renderHook(() => useTeamsAuth())
    await settle()
    expect(result.current.error).toMatch(/not set up correctly/)
  })

  it('classifies an OBO exchange failure separately from a Teams SSO failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'OBO exchange failed', code: 'AADSTS65001' }),
    }) as any
    const { result } = renderHook(() => useTeamsAuth())
    await settle()
    expect(result.current.error).toMatch(/haven't consented/)
  })

  it('reacquires the Teams SSO token once when the edge rejects an expired JWT', async () => {
    getAuthToken
      .mockResolvedValueOnce('expired-entra-token')
      .mockResolvedValueOnce('fresh-entra-token')
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'OBO exchange failed', code: 'ERR_JWT_EXPIRED' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ expiresIn: 3600, edgeSession: 'fresh-edge-sess' }),
      }) as any

    const { result } = renderHook(() => useTeamsAuth())
    await settle()

    expect(result.current.edgeSession).toBe('fresh-edge-sess')
    expect(result.current.error).toBeNull()
    expect(getAuthToken).toHaveBeenCalledTimes(2)
    expect(getAuthToken).toHaveBeenLastCalledWith({ silent: false })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse((global.fetch as any).mock.calls[1][1].body)).toEqual({
      entraToken: 'fresh-entra-token',
    })
  })

  it('stops after one expired-JWT reacquisition when the Teams cache stays stale', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'OBO exchange failed', code: 'ERR_JWT_EXPIRED' }),
    }) as any

    const { result } = renderHook(() => useTeamsAuth())
    await settle()

    expect(result.current.error).toMatch(/sign-in session has expired/)
    expect(getAuthToken).toHaveBeenCalledTimes(2)
    expect(getAuthToken).toHaveBeenLastCalledWith({ silent: false })
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('falls back to a generic message for an unrecognized failure', async () => {
    getAuthToken.mockRejectedValue(new Error('something unexpected'))
    const { result } = renderHook(() => useTeamsAuth())
    await settle()
    expect(result.current.error).toMatch(/Couldn't sign you in/)
  })

  it('retry re-runs the auth handshake and clears the prior error', async () => {
    getAuthToken.mockRejectedValueOnce(new Error('transient failure'))
    const { result } = renderHook(() => useTeamsAuth())
    await settle()
    expect(result.current.error).not.toBeNull()

    getAuthToken.mockResolvedValue('entra-token')
    await act(async () => {
      result.current.retry()
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(result.current.error).toBeNull()
    expect(result.current.edgeSession).toBe('edge-sess')
  })
})

describe('refreshDelayMs', () => {
  it('clamps missing, tiny, and non-numeric values so refresh cannot hot-loop', () => {
    expect(refreshDelayMs(3600)).toBe(3540_000)
    expect(refreshDelayMs(90)).toBe(30_000)
    expect(refreshDelayMs(30)).toBe(3540_000)
    expect(refreshDelayMs(undefined)).toBe(3540_000)
    expect(refreshDelayMs('nope')).toBe(3540_000)
  })
})

describe('classifyAuthError', () => {
  it('maps known AADSTS codes and falls back to a generic message otherwise', () => {
    expect(classifyAuthError('AADSTS65001: ...')).toMatch(/haven't consented/)
    expect(classifyAuthError('AADSTS700016: ...')).toMatch(/not set up correctly/)
    expect(classifyAuthError('ERR_JWT_EXPIRED')).toMatch(/sign-in session has expired/)
    expect(classifyAuthError('TypeError: fetch failed')).toMatch(/reach Snowflake/)
    expect(classifyAuthError('boom')).toMatch(/Couldn't sign you in/)
  })
})
