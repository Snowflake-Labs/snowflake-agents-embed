// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DeepResearchChip } from './DeepResearchChip'
import { useChatStore } from '../../../store/chatStore'

beforeEach(() => {
  useChatStore.setState({ deepResearch: false })
})

describe('DeepResearchChip', () => {
  it('renders nothing when deep research is off', () => {
    const { container } = render(<DeepResearchChip />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the chip when deep research is on, and dismissing it turns the boolean off', () => {
    useChatStore.setState({ deepResearch: true })
    render(<DeepResearchChip />)
    expect(screen.getByText('Research')).toBeTruthy()

    fireEvent.click(screen.getByTitle('Turn off deep research'))
    expect(useChatStore.getState().deepResearch).toBe(false)
  })
})
