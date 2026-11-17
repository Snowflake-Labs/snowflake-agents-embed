// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatErrorBoundary } from './ChatErrorBoundary.js'

function Boom(): never {
  throw new Error('boom')
}

describe('ChatErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(<ChatErrorBoundary><div>ok</div></ChatErrorBoundary>)
    expect(screen.getByText('ok')).toBeTruthy()
  })

  it('renders a fallback instead of unmounting the whole tree when a child throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ChatErrorBoundary><Boom /></ChatErrorBoundary>)
    expect(screen.getByText(/something went wrong/i)).toBeTruthy()
  })

  it('lets the user retry, re-rendering children', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let shouldThrow = true
    function Flaky() {
      if (shouldThrow) throw new Error('boom')
      return <div>recovered</div>
    }
    render(<ChatErrorBoundary><Flaky /></ChatErrorBoundary>)
    shouldThrow = false
    fireEvent.click(screen.getByText(/try again/i))
    expect(screen.getByText('recovered')).toBeTruthy()
  })
})
