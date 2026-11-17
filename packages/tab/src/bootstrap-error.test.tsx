// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BOOTSTRAP_ERROR_COPY, BootstrapErrorPanel, renderBootstrapError } from './bootstrap-error.js'

describe('BootstrapErrorPanel', () => {
  it('tells the user to reload after a Teams SDK failure', () => {
    render(<BootstrapErrorPanel />)
    expect(screen.getByText(BOOTSTRAP_ERROR_COPY)).toBeTruthy()
  })
})

describe('renderBootstrapError', () => {
  it('mounts the panel into the given root', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    renderBootstrapError(root)
    await waitFor(() => {
      expect(root.textContent).toContain(BOOTSTRAP_ERROR_COPY)
    })
    root.remove()
  })

  it('is a no-op when there is no root element', () => {
    expect(() => renderBootstrapError(null)).not.toThrow()
  })
})
