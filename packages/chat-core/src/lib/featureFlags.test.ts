// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { getFeatureFlags, getDefaultAgentFqn, setFeatureFlags, resetFeatureFlags, loadFeatureFlags, subscribeFeatureFlags } from './featureFlags'
import { setHostAdapter, resetHostAdapter } from '../host/hostAdapter'

beforeEach(() => {
  setHostAdapter({
    baseUrl: () => 'https://server.example',
    headers: (token, extra) => ({ Authorization: `Snowflake Token="${token ?? ''}"`, ...extra }),
  })
})

afterEach(() => { resetFeatureFlags(); resetHostAdapter(); vi.unstubAllGlobals() })

describe('featureFlags', () => {
  it('falls back to build-time VITE_FF_* defaults (all false in this test env) before setFeatureFlags is ever called', () => {
    expect(getFeatureFlags()).toEqual({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
  })

  it('returns whatever was set once setFeatureFlags is called', () => {
    setFeatureFlags({ fileUpload: true, deepResearch: false, skills: true, webSearch: true, richComposer: false, nativeStreamFlags: false })
    expect(getFeatureFlags()).toEqual({ fileUpload: true, deepResearch: false, skills: true, webSearch: true, richComposer: false, nativeStreamFlags: false })
  })

  it('resetFeatureFlags reverts to the build-time fallback', () => {
    setFeatureFlags({ fileUpload: true, deepResearch: true, skills: true, webSearch: true, richComposer: true, nativeStreamFlags: false })
    resetFeatureFlags()
    expect(getFeatureFlags()).toEqual({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
  })
})

describe('loadFeatureFlags', () => {
  it('authenticates the config request through the host adapter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await loadFeatureFlags('https://server.example', 'salesforce-jwt')

    expect(fetchMock).toHaveBeenCalledWith('https://server.example/api/config', {
      headers: { Authorization: 'Snowflake Token="salesforce-jwt"' },
    })
  })

  it('applies a well-formed /api/config response via setFeatureFlags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ fileUpload: true, deepResearch: true, skills: true, webSearch: true, richComposer: true, nativeStreamFlags: false }), { status: 200 },
    )))
    await loadFeatureFlags('https://server.example')
    expect(getFeatureFlags()).toEqual({ fileUpload: true, deepResearch: true, skills: true, webSearch: true, richComposer: true, nativeStreamFlags: false })
  })

  it('leaves the build-time fallback in place on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await loadFeatureFlags('https://server.example')
    expect(getFeatureFlags()).toEqual({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
  })

  it('leaves the build-time fallback in place on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(loadFeatureFlags('https://server.example')).resolves.toBeUndefined()
    expect(getFeatureFlags()).toEqual({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
  })

  it('applies flags from an older partial response and defaults newer omitted flags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      fileUpload: true,
      deepResearch: true,
      skills: true,
      webSearch: true,
    }), { status: 200 })))
    await loadFeatureFlags('https://server.example')
    expect(getFeatureFlags()).toEqual({
      fileUpload: true,
      deepResearch: true,
      skills: true,
      webSearch: true,
      richComposer: false,
      nativeStreamFlags: false,
    })
  })

  it('ignores incorrectly typed fields while applying valid booleans independently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      fileUpload: true,
      deepResearch: 'true',
      skills: false,
    }), { status: 200 })))
    await loadFeatureFlags('https://server.example')
    expect(getFeatureFlags()).toEqual({
      fileUpload: true,
      deepResearch: false,
      skills: false,
      webSearch: false,
      richComposer: false,
      nativeStreamFlags: false,
    })
  })

  it('uses build-time defaults for an empty config payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })))
    await loadFeatureFlags('https://server.example')
    expect(getFeatureFlags()).toEqual({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    expect(getDefaultAgentFqn()).toBe('')
  })

  it('stores defaultAgentFqn from /api/config and ignores a missing or non-string field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      defaultAgentFqn: 'DB.SCH.AG',
    }), { status: 200 })))
    await loadFeatureFlags('https://server.example')
    expect(getDefaultAgentFqn()).toBe('DB.SCH.AG')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      defaultAgentFqn: 12,
    }), { status: 200 })))
    await loadFeatureFlags('https://server.example')
    expect(getDefaultAgentFqn()).toBe('DB.SCH.AG')
  })
})

describe('subscribeFeatureFlags', () => {
  it('notifies subscribers when setFeatureFlags is called', () => {
    const listener = vi.fn()
    const unsub = subscribeFeatureFlags(listener)
    setFeatureFlags({ fileUpload: true, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    expect(listener).toHaveBeenCalledOnce()
    unsub()
    setFeatureFlags({ fileUpload: false, deepResearch: false, skills: false, webSearch: false, richComposer: false, nativeStreamFlags: false })
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('useFeatureFlags snapshot', () => {
  it('returns the same object from getFeatureFlags until setFeatureFlags is called', () => {
    // useSyncExternalStore compares snapshots with Object.is; a new object every
    // read would loop ComposerMenu / MessageInput.
    expect(getFeatureFlags()).toBe(getFeatureFlags())
  })
})
