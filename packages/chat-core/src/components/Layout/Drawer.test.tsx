// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Drawer } from './Drawer'

describe('Drawer keyboard behavior', () => {
  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    render(<Drawer open side="left" onClose={onClose}><button>Inside</button></Drawer>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose on a backdrop click', () => {
    const onClose = vi.fn()
    const { container } = render(<Drawer open side="left" onClose={onClose}><button>Inside</button></Drawer>)
    fireEvent.click(container.querySelector('.drawer-backdrop')!)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('wraps Tab focus from the last focusable element back to the first', () => {
    render(
      <Drawer open side="left" onClose={vi.fn()}>
        <button>First</button>
        <button>Last</button>
      </Drawer>,
    )
    const last = screen.getByText('Last')
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('First'))
  })

  it('wraps Shift+Tab focus from the first focusable element back to the last', () => {
    render(
      <Drawer open side="left" onClose={vi.fn()}>
        <button>First</button>
        <button>Last</button>
      </Drawer>,
    )
    const first = screen.getByText('First')
    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByText('Last'))
  })

  it('renders nothing when closed', () => {
    const { container } = render(<Drawer open={false} side="left" onClose={vi.fn()}><button>Inside</button></Drawer>)
    expect(container.querySelector('.drawer-backdrop')).toBeNull()
  })
})
