// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('@microsoft/teams-js', () => ({
  app: { initialize: vi.fn().mockResolvedValue(undefined) },
  authentication: { getAuthToken: vi.fn().mockResolvedValue('entra-token') },
}))

import { LinkScreen } from './LinkScreen.js'

beforeEach(() => vi.stubGlobal('fetch', vi.fn()))

describe('LinkScreen', () => {
  it('posts the code and Entra token to /token/link once and shows success', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ linked: true }))
    render(<LinkScreen code="abc" />)
    await screen.findByText(/signed in/i)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/token/link')
    expect(JSON.parse(init.body as string)).toEqual({ code: 'abc', entraToken: 'entra-token' })
  })

  it('shows the edge message for a used code', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ error: 'This sign-in link has already been used.', reason: 'used' }, { status: 409 }),
    )
    render(<LinkScreen code="abc" />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('already been used'))
  })
})
