// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest'
import { getAllThreadFlags, setThreadPinned, setThreadArchived } from './threadFlags'

beforeEach(() => { sessionStorage.clear() })

describe('threadFlags', () => {
  it('starts empty', () => {
    expect(getAllThreadFlags()).toEqual({})
  })

  it('sets and reads pinned independently per thread', () => {
    setThreadPinned(1, true)
    setThreadPinned(2, true)
    setThreadPinned(1, false)
    expect(getAllThreadFlags()).toEqual({ '1': { pinned: false }, '2': { pinned: true } })
  })

  it('keeps pinned and archived independent on the same thread', () => {
    setThreadPinned(1, true)
    setThreadArchived(1, true)
    expect(getAllThreadFlags()['1']).toEqual({ pinned: true, archived: true })
  })

  it('tolerates corrupt sessionStorage content', () => {
    sessionStorage.setItem('agents_thread_flags', 'not json')
    expect(getAllThreadFlags()).toEqual({})
    setThreadPinned(1, true)
    expect(getAllThreadFlags()).toEqual({ '1': { pinned: true } })
  })
})
