// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchAgents, fetchSampleQuestions, fetchSampleQuestionsCached, clearSampleQuestionsCache,
  fetchAgentDetails, fetchAgentDetailsCached, clearAgentDetailsCache,
} from './agents'
import { setHostAdapter, resetHostAdapter, type HostAdapter } from '../host/hostAdapter'

const fakeAdapter: HostAdapter = {
  baseUrl: () => '',
  headers: (token, extra) => ({ 'X-User-Access-Token': token ?? '', ...extra }),
}

beforeEach(() => { setHostAdapter(fakeAdapter) })
afterEach(() => { vi.unstubAllGlobals(); resetHostAdapter() })

describe('fetchAgents', () => {
  it('returns the parsed agent list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify([{ fqn: 'DB.SCH.A', displayName: 'A' }]), { status: 200 },
    )))
    expect(await fetchAgents('tok')).toEqual([{ fqn: 'DB.SCH.A', displayName: 'A' }])
  })

  it('retries once when onUnauthorized remints after a 401', async () => {
    const onUnauthorized = vi.fn().mockResolvedValue('fresh')
    setHostAdapter({ ...fakeAdapter, onUnauthorized })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ fqn: 'DB.SCH.A', displayName: 'A' }]), { status: 200 })),
    )
    expect(await fetchAgents('stale')).toEqual([{ fqn: 'DB.SCH.A', displayName: 'A' }])
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })
})

describe('fetchSampleQuestions', () => {
  it('returns the questions array on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ questions: ['Q1'] }), { status: 200 })))
    expect(await fetchSampleQuestions('tok', 'DB.SCH.A')).toEqual(['Q1'])
  })

  it('returns [] on a non-OK response or a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    expect(await fetchSampleQuestions('tok', 'DB.SCH.A')).toEqual([])

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    expect(await fetchSampleQuestions('tok', 'DB.SCH.A')).toEqual([])
  })
})

describe('fetchSampleQuestionsCached', () => {
  afterEach(() => { clearSampleQuestionsCache() })

  it('shares one in-flight request across concurrent callers for the same fqn', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ questions: ['Q1'] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const [a, b] = await Promise.all([
      fetchSampleQuestionsCached('tok', 'DB.SCH.A'),
      fetchSampleQuestionsCached('tok', 'DB.SCH.A'),
    ])
    expect(a).toEqual(b)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not re-fetch on a second call for an already-resolved fqn', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ questions: ['Q1'] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchSampleQuestionsCached('tok', 'DB.SCH.A')).toEqual(['Q1'])
    expect(await fetchSampleQuestionsCached('tok', 'DB.SCH.A')).toEqual(['Q1'])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not cache an empty/failed result, so a later call retries', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('nope', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchSampleQuestionsCached('tok', 'DB.SCH.A')).toEqual([])

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ questions: ['Q1'] }), { status: 200 }))
    expect(await fetchSampleQuestionsCached('tok', 'DB.SCH.A')).toEqual(['Q1'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('fetchAgentDetails', () => {
  it('returns the parsed details on success', async () => {
    const details = { orchestrationModel: 'claude-sonnet-4-5', sampleQuestions: [], tools: [], dataSources: [], skills: [] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(details), { status: 200 })))
    expect(await fetchAgentDetails('tok', 'DB.SCH.A')).toEqual(details)
  })

  it('returns null on a non-OK response or a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })))
    expect(await fetchAgentDetails('tok', 'DB.SCH.A')).toBeNull()

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    expect(await fetchAgentDetails('tok', 'DB.SCH.A')).toBeNull()
  })

  it('URL-encodes the fqn query param', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sampleQuestions: [], tools: [], dataSources: [], skills: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchAgentDetails('tok', 'DB.SCH.A B')
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('fqn=DB.SCH.A%20B'), expect.anything())
  })
})

describe('fetchAgentDetailsCached', () => {
  afterEach(() => { clearAgentDetailsCache() })

  it('shares one in-flight request across concurrent callers for the same fqn', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ sampleQuestions: [], tools: [], dataSources: [], skills: [] }), { status: 200 },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const [a, b] = await Promise.all([
      fetchAgentDetailsCached('tok', 'DB.SCH.A'),
      fetchAgentDetailsCached('tok', 'DB.SCH.A'),
    ])
    expect(a).toEqual(b)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not re-fetch on a second call for an already-resolved fqn', async () => {
    const details = { sampleQuestions: [], tools: [], dataSources: [], skills: [] }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(details), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchAgentDetailsCached('tok', 'DB.SCH.A')).toEqual(details)
    expect(await fetchAgentDetailsCached('tok', 'DB.SCH.A')).toEqual(details)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not cache a failed fetch, so a later call retries', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('nope', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchAgentDetailsCached('tok', 'DB.SCH.A')).toBeNull()

    const details = { sampleQuestions: [], tools: [], dataSources: [], skills: [] }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(details), { status: 200 }))
    expect(await fetchAgentDetailsCached('tok', 'DB.SCH.A')).toEqual(details)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
