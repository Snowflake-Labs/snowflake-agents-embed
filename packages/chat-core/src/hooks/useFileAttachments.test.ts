// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useFileAttachments } from './useFileAttachments'

afterEach(() => { vi.clearAllMocks() })

describe('useFileAttachments', () => {
  it('reads text files, skipping unsupported types', async () => {
    const onAdd = vi.fn()
    const { result } = renderHook(() => useFileAttachments(onAdd))

    const text = new File(['fake'], 'notes.txt', { type: 'text/plain' })
    const image = new File(['fake'], 'photo.png', { type: 'image/png' })
    const unsupported = new File(['fake'], 'report.pdf', { type: 'application/pdf' })
    await result.current([text, image, unsupported])

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1))
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ name: 'notes.txt', data: 'fake' }))
  })

  it('is a no-op for null/undefined file lists', async () => {
    const onAdd = vi.fn()
    const { result } = renderHook(() => useFileAttachments(onAdd))
    await result.current(null)
    await result.current(undefined)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('skips a text file that exceeds the size cap without throwing', async () => {
    const onAdd = vi.fn()
    const { result } = renderHook(() => useFileAttachments(onAdd))
    const big = new File([new Uint8Array(200_000)], 'huge.csv', { type: 'text/csv' })

    await expect(result.current([big])).resolves.toBeUndefined()
    expect(onAdd).not.toHaveBeenCalled()
  })
})
