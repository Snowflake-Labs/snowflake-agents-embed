// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVoiceDictation } from './useVoiceDictation'
import { setHostAdapter, type HostAdapter } from '../host/hostAdapter'

// Matches test-setup.ts's default - restored after every test so tests that swap in a
// platform-specific adapter (below) don't leave later tests without one.
const DEFAULT_ADAPTER: HostAdapter = {
  baseUrl: () => '',
  headers: (token, extra) => ({ 'X-User-Access-Token': token ?? '', ...extra }),
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setHostAdapter(DEFAULT_ADAPTER) })

interface FakeResult {
  isFinal: boolean
  0: { transcript: string }
  length: number
}

function finalResult(transcript: string): FakeResult {
  return { isFinal: true, 0: { transcript }, length: 1 }
}
function interimResult(transcript: string): FakeResult {
  return { isFinal: false, 0: { transcript }, length: 1 }
}

class FakeSpeechRecognition {
  continuous = false
  interimResults = false
  lang = ''
  onresult: ((e: unknown) => void) | null = null
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  start = vi.fn()
  stop = vi.fn(() => { this.onend?.() })
  abort = vi.fn()
}

function stubRecognitionCtor() {
  const instances: FakeSpeechRecognition[] = []
  const ctor = vi.fn(function () {
    const instance = new FakeSpeechRecognition()
    instances.push(instance)
    return instance
  })
  vi.stubGlobal('SpeechRecognition', ctor)
  return { ctor, instances, current: () => instances[instances.length - 1] }
}

describe('useVoiceDictation', () => {
  it('reports unsupported when no SpeechRecognition constructor exists on window', () => {
    const { result } = renderHook(() => useVoiceDictation(vi.fn()))
    expect(result.current.supported).toBe(false)
  })

  it('starts continuous, interim-enabled recognition and clears listening on an unarmed end', () => {
    const { current } = stubRecognitionCtor()
    const { result } = renderHook(() => useVoiceDictation(vi.fn()))
    expect(result.current.supported).toBe(true)

    act(() => { result.current.start() })
    expect(result.current.listening).toBe(true)
    expect(current().continuous).toBe(true)
    expect(current().interimResults).toBe(true)
    expect(current().start).toHaveBeenCalled()

    act(() => { result.current.stop() })
    expect(result.current.listening).toBe(false)
  })

  it('delivers only new final results (by resultIndex), and reports interim text separately', () => {
    const { current } = stubRecognitionCtor()
    const onFinal = vi.fn()
    const onInterim = vi.fn()
    const { result } = renderHook(() => useVoiceDictation(onFinal, onInterim))
    act(() => { result.current.start() })

    // First event: one interim result in progress.
    act(() => { current().onresult?.({ resultIndex: 0, results: [interimResult('show sal')] }) })
    expect(onFinal).not.toHaveBeenCalled()
    expect(result.current.interim).toBe('show sal')
    expect(onInterim).toHaveBeenCalledWith('show sal')

    // Second event: that same segment finalizes at index 0, a new interim starts at index 1.
    // resultIndex stays 0 (browsers re-report from the earliest result still "in flight").
    act(() => {
      current().onresult?.({
        resultIndex: 0,
        results: [finalResult('show sales'), interimResult('by reg')],
      })
    })
    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith('show sales')
    expect(result.current.interim).toBe('by reg')

    // Third event repeats index 0 (now final) again with resultIndex 0 - must not re-deliver.
    act(() => {
      current().onresult?.({
        resultIndex: 0,
        results: [finalResult('show sales'), finalResult('by region')],
      })
    })
    expect(onFinal).toHaveBeenCalledTimes(2)
    expect(onFinal).toHaveBeenLastCalledWith('by region')
  })

  it('auto-restarts after onend while armed, with no restart once stop() has been called', () => {
    vi.useFakeTimers()
    const { ctor, current } = stubRecognitionCtor()
    const { result } = renderHook(() => useVoiceDictation(vi.fn()))
    act(() => { result.current.start() })
    expect(ctor).toHaveBeenCalledTimes(1)

    act(() => { current().onend?.() })
    act(() => { vi.advanceTimersByTime(0) })
    expect(ctor).toHaveBeenCalledTimes(2)
    expect(current().start).toHaveBeenCalled()

    act(() => { result.current.stop() })
    const callsAfterStop = ctor.mock.calls.length
    act(() => { vi.advanceTimersByTime(5000) })
    expect(ctor).toHaveBeenCalledTimes(callsAfterStop)
    expect(result.current.listening).toBe(false)
  })

  it('resets the restart backoff counter once a result arrives, and disarms after too many empty restarts', () => {
    vi.useFakeTimers()
    const { ctor, current } = stubRecognitionCtor()
    const { result } = renderHook(() => useVoiceDictation(vi.fn()))
    act(() => { result.current.start() })

    // One real result partway through - must not count toward the empty-restart cap.
    act(() => { current().onresult?.({ resultIndex: 0, results: [finalResult('hi')] }) })
    act(() => { current().onend?.() })
    act(() => { vi.runOnlyPendingTimers() })

    // Now run it dry: onend with no results, repeatedly, until the cap disarms it.
    for (let i = 0; i < 8; i++) {
      act(() => { current().onend?.() })
      act(() => { vi.runOnlyPendingTimers() })
    }

    expect(result.current.listening).toBe(false)
    expect(result.current.error).toMatch(/no speech detected/i)
    // No further restart is scheduled once disarmed.
    const callsAtDisarm = ctor.mock.calls.length
    act(() => { vi.runAllTimers() })
    expect(ctor).toHaveBeenCalledTimes(callsAtDisarm)
  })

  it('does not disarm on a no-speech error, but does disarm and set a message on not-allowed', () => {
    const { current } = stubRecognitionCtor()
    const { result } = renderHook(() => useVoiceDictation(vi.fn()))
    act(() => { result.current.start() })

    act(() => { current().onerror?.({ error: 'no-speech' }) })
    expect(result.current.listening).toBe(true)
    expect(result.current.error).toBeNull()

    act(() => { current().onerror?.({ error: 'not-allowed' }) })
    expect(result.current.listening).toBe(false)
    expect(result.current.error).toMatch(/microphone access is blocked — allow it in your browser/i)
  })

  it('reports unsupported when running under a Teams host, even with a SpeechRecognition constructor present', () => {
    setHostAdapter({ ...DEFAULT_ADAPTER, platform: 'teams' })
    const { ctor } = stubRecognitionCtor()
    const { result } = renderHook(() => useVoiceDictation(vi.fn()))
    expect(result.current.supported).toBe(false)

    act(() => { result.current.start() })
    expect(result.current.listening).toBe(false)
    expect(ctor).not.toHaveBeenCalled()
  })

  it('reports unsupported when running under a Tableau host, even with a SpeechRecognition constructor present', () => {
    setHostAdapter({ ...DEFAULT_ADAPTER, platform: 'tableau' })
    const { ctor } = stubRecognitionCtor()
    const { result } = renderHook(() => useVoiceDictation(vi.fn()))
    expect(result.current.supported).toBe(false)

    act(() => { result.current.start() })
    expect(result.current.listening).toBe(false)
    expect(ctor).not.toHaveBeenCalled()
  })

  it('surfaces a network error as unavailable-in-this-client', () => {
    const { current } = stubRecognitionCtor()
    const { result } = renderHook(() => useVoiceDictation(vi.fn()))
    act(() => { result.current.start() })
    act(() => { current().onerror?.({ error: 'network' }) })
    expect(result.current.error).toMatch(/unavailable in this client/i)
  })

  it('probes getUserMedia on the first start() only, stopping the tracks immediately', async () => {
    const { current } = stubRecognitionCtor()
    const track = { stop: vi.fn() }
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [track] })
    vi.stubGlobal('navigator', { language: 'en-US', mediaDevices: { getUserMedia } })

    const { result } = renderHook(() => useVoiceDictation(vi.fn()))
    await act(async () => { result.current.start() })
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(track.stop).toHaveBeenCalled()
    expect(current().start).toHaveBeenCalled()

    await act(async () => { result.current.stop() })
    await act(async () => { result.current.start() })
    expect(getUserMedia).toHaveBeenCalledOnce()
  })

  it('surfaces a rejected getUserMedia probe as an error and never starts recognition', async () => {
    stubRecognitionCtor()
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    vi.stubGlobal('navigator', { language: 'en-US', mediaDevices: { getUserMedia } })

    const { result } = renderHook(() => useVoiceDictation(vi.fn()))
    await act(async () => { result.current.start() })
    expect(result.current.listening).toBe(false)
    expect(result.current.error).toMatch(/microphone access is blocked — allow it in your browser/i)
  })
})
