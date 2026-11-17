// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThinkingToggle } from './ThinkingToggle'
import { useChatStore } from '../../../store/chatStore'

beforeEach(() => {
  useChatStore.setState({ extendedThinking: false })
})

describe('ThinkingToggle', () => {
  it('toggles the extendedThinking store boolean', () => {
    render(<ThinkingToggle />)
    const btn = screen.getByRole('button', { name: /Extended thinking/i })
    expect(btn.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(btn)
    expect(useChatStore.getState().extendedThinking).toBe(true)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.className).toContain('thinking-toggle--on')

    fireEvent.click(btn)
    expect(useChatStore.getState().extendedThinking).toBe(false)
  })
})
