// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { useBeforeUnloadWarning } from './useBeforeUnloadWarning'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('useBeforeUnloadWarning', () => {
  it('registers a beforeunload listener only while active, and tears it down on cleanup', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    const { rerender, unmount } = renderHook(({ active }) => useBeforeUnloadWarning(active), {
      initialProps: { active: false },
    })
    expect(addSpy).not.toHaveBeenCalledWith('beforeunload', expect.anything())

    rerender({ active: true })
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))

    rerender({ active: false })
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))

    unmount()
  })

  it('the registered handler prevents default and sets returnValue', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    renderHook(() => useBeforeUnloadWarning(true))

    const [, handler] = addSpy.mock.calls.find(([name]) => name === 'beforeunload')!
    const event = { preventDefault: vi.fn(), returnValue: undefined } as unknown as BeforeUnloadEvent
    ;(handler as (e: BeforeUnloadEvent) => void)(event)

    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.returnValue).toBe('')
  })
})
