// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AttachmentBar } from './AttachmentBar'

describe('AttachmentBar', () => {
  it('renders a name chip for an attachment', () => {
    render(
      <AttachmentBar
        attachments={[{ name: 'report.pdf', mimeType: 'application/pdf', data: 'ZmFrZQ==', sizeBytes: 4 }]}
        onRemove={vi.fn()}
      />,
    )
    expect(screen.getByText('report.pdf')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('calls onRemove with the clicked attachment index', async () => {
    const onRemove = vi.fn()
    render(
      <AttachmentBar
        attachments={[{ name: 'a.txt', mimeType: 'text/plain', data: 'AA==', sizeBytes: 1 }]}
        onRemove={onRemove}
      />,
    )
    screen.getByTitle('Remove a.txt').click()
    expect(onRemove).toHaveBeenCalledWith(0)
  })

  it('renders nothing when there are no attachments', () => {
    const { container } = render(<AttachmentBar attachments={[]} onRemove={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })
})
