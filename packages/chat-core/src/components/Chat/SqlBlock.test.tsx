// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SqlBlock } from './SqlBlock'

describe('SqlBlock', () => {
  it('renders crafted HTML in the SQL as text, not a DOM node', () => {
    render(<SqlBlock sql={'SELECT 1 -- <img src=x onerror="alert(1)">'} />)
    fireEvent.click(screen.getByRole('button', { name: 'View SQL' }))
    const code = screen.getByText(/SELECT 1/, { exact: false })
    expect(code.querySelector('img')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(screen.getByText(/onerror/, { exact: false }).tagName).toBe('CODE')
  })
})
