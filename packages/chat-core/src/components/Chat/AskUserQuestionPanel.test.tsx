// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AskUserQuestionPanel } from './AskUserQuestionPanel'

describe('AskUserQuestionPanel', () => {
  it('renders fixed options as buttons and answers with the clicked option', () => {
    const onAnswer = vi.fn()
    render(
      <AskUserQuestionPanel
        pendingQuestion={{ toolUseId: 't1', toolType: 'ask_user_question', prompt: 'Which region?', options: ['Central', 'North'] }}
        onAnswer={onAnswer}
      />,
    )
    expect(screen.getByText('Which region?')).toBeTruthy()
    fireEvent.click(screen.getByText('North'))
    expect(onAnswer).toHaveBeenCalledWith('North')
  })

  it('falls back to free text when no options are present, answering as a plain user turn', () => {
    const onAnswer = vi.fn()
    render(
      <AskUserQuestionPanel
        pendingQuestion={{ toolUseId: 't1', toolType: 'ask_user_question', prompt: 'What date range?' }}
        onAnswer={onAnswer}
      />,
    )
    fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'Last quarter' } })
    fireEvent.click(screen.getByText('Send'))
    expect(onAnswer).toHaveBeenCalledWith('Last quarter')
  })

  it('does not answer with an empty free-text submission', () => {
    const onAnswer = vi.fn()
    render(
      <AskUserQuestionPanel
        pendingQuestion={{ toolUseId: 't1', toolType: 'permission_decision', prompt: 'Update the record?' }}
        onAnswer={onAnswer}
      />,
    )
    fireEvent.click(screen.getByText('Send'))
    expect(onAnswer).not.toHaveBeenCalled()
  })
})
