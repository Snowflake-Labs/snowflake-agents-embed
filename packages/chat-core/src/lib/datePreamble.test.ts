// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildClientDateContext } from './datePreamble'

describe('buildClientDateContext', () => {
  afterEach(() => { vi.useRealTimers() })

  it('always sends the native date/chart flags and the browser timezone', () => {
    const ctx = buildClientDateContext()
    expect(ctx.EnableClientSideDateFormatting).toBe(true)
    expect(ctx.EnableAnswerBeforeProactiveChartGeneration).toBe(true)
    expect(ctx.UserTimezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(ctx.systemPromptInternal).toBeUndefined()
  })

  it('adds systemPromptInternal attributes when a user name is given', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T12:34:56Z'))
    const ctx = buildClientDateContext('Jordan Rivera')
    expect(ctx.systemPromptInternal).toEqual({
      prompt: 'The current date and time is {{.date}}, my username is {{.username}}, my full name is {{.fullName}}, my email is {{.email}}',
      attributes: {
        date: '2026-08-27T12:34:56.000Z',
        fullName: 'Jordan Rivera',
        email: '',
        username: 'Jordan Rivera',
      },
    })
  })
})
