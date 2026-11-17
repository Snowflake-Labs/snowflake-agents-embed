// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { throttledSessionStorage } from './throttledStorage'

describe('throttledSessionStorage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('writes nothing until the window elapses', () => {
    const storage = throttledSessionStorage<{ n: number }>(1000)
    storage.setItem('k', { state: { n: 1 } })
    expect(sessionStorage.getItem('k')).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(JSON.parse(sessionStorage.getItem('k')!)).toEqual({ state: { n: 1 } })
  })

  it('coalesces a burst into one write, keeping the last value', () => {
    const spy = vi.spyOn(sessionStorage, 'setItem')
    const storage = throttledSessionStorage<{ n: number }>(1000)
    for (let n = 1; n <= 20; n++) storage.setItem('k', { state: { n } })
    vi.advanceTimersByTime(1000)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(sessionStorage.getItem('k')!)).toEqual({ state: { n: 20 } })
  })

  it('serves a pending value back from getItem before it lands', () => {
    const storage = throttledSessionStorage<{ n: number }>(1000)
    storage.setItem('k', { state: { n: 7 } })
    expect(storage.getItem('k')).toEqual({ state: { n: 7 } })
  })

  it('reads a previously stored value back', () => {
    sessionStorage.setItem('k', JSON.stringify({ state: { n: 3 }, version: 0 }))
    const storage = throttledSessionStorage<{ n: number }>(1000)
    expect(storage.getItem('k')).toEqual({ state: { n: 3 }, version: 0 })
  })

  it('returns null for an absent or unparseable key', () => {
    const storage = throttledSessionStorage<{ n: number }>(1000)
    expect(storage.getItem('missing')).toBeNull()
    sessionStorage.setItem('bad', 'not json')
    expect(storage.getItem('bad')).toBeNull()
  })

  it('flushes a pending write on pagehide', () => {
    const storage = throttledSessionStorage<{ n: number }>(1000)
    storage.setItem('k', { state: { n: 9 } })
    dispatchEvent(new Event('pagehide'))
    expect(JSON.parse(sessionStorage.getItem('k')!)).toEqual({ state: { n: 9 } })
    // The cancelled timer must not write a second time.
    const spy = vi.spyOn(sessionStorage, 'setItem')
    vi.advanceTimersByTime(2000)
    expect(spy).not.toHaveBeenCalled()
  })

  it('drops the pending write when the key is removed', () => {
    const storage = throttledSessionStorage<{ n: number }>(1000)
    storage.setItem('k', { state: { n: 1 } })
    storage.removeItem('k')
    vi.advanceTimersByTime(1000)
    expect(sessionStorage.getItem('k')).toBeNull()
  })

  it('applies transform only when serializing, not on getItem of a pending value', () => {
    const storage = throttledSessionStorage<{ n: number }>(1000, (v) => ({ ...v, state: { n: v.state.n * 10 } }))
    storage.setItem('k', { state: { n: 2 } })
    expect(storage.getItem('k')).toEqual({ state: { n: 2 } })
    vi.advanceTimersByTime(1000)
    expect(JSON.parse(sessionStorage.getItem('k')!)).toEqual({ state: { n: 20 } })
  })

  it('survives a storage that throws (quota, restricted iframe)', () => {
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded') })
    const storage = throttledSessionStorage<{ n: number }>(1000)
    storage.setItem('k', { state: { n: 1 } })
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
  })
})
