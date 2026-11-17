// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { LexicalComposerInput } from './LexicalComposerInput'
import type { LexicalComposerInputHandle } from './LexicalComposerInput'

function renderInput(overrides: Partial<Parameters<typeof LexicalComposerInput>[0]> = {}) {
  const ref = createRef<LexicalComposerInputHandle>()
  const onChange = vi.fn()
  const onSubmit = vi.fn()
  const onEscape = vi.fn()
  render(
    <LexicalComposerInput
      ref={ref}
      onChange={onChange}
      onSubmit={onSubmit}
      onEscape={onEscape}
      onPasteFiles={undefined}
      placeholder="Ask anything..."
      isMentionMenuOpen={false}
      committedVoiceText={null}
      onCommittedVoiceTextAppended={vi.fn()}
      {...overrides}
    />,
  )
  return { ref, onChange, onSubmit, onEscape }
}

describe('LexicalComposerInput', () => {
  it('setText replaces the content without firing onChange (programmatic)', async () => {
    const { ref, onChange } = renderInput()
    ref.current!.setText('hello world')
    await waitFor(() => expect(screen.getByTestId('lexical-composer-input').textContent).toBe('hello world'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('clearEditor empties the content', async () => {
    const { ref } = renderInput()
    ref.current!.setText('scratch that')
    await waitFor(() => expect(screen.getByTestId('lexical-composer-input').textContent).toBe('scratch that'))
    ref.current!.clearEditor()
    await waitFor(() => expect(screen.getByTestId('lexical-composer-input').textContent).toBe(''))
  })

  it('insertMentionPillAtCursor renders an inline pill and fires onChange', async () => {
    const { ref, onChange } = renderInput()
    ref.current!.focus()
    ref.current!.insertMentionPillAtCursor('DB.SCH.A', 'Agent A')
    await waitFor(() => expect(screen.getByTestId('agent-mention-pill')).toBeTruthy())
    expect(screen.getByTestId('agent-mention-pill').textContent).toContain('Agent A')
    // The pill serializes to '' (see serializeEditorState.ts), so only the trailing space remains.
    await waitFor(() => expect(onChange).toHaveBeenCalled())
  })

  it('removing a mention pill drops it from the editor', async () => {
    const { ref } = renderInput()
    ref.current!.focus()
    ref.current!.insertMentionPillAtCursor('DB.SCH.A', 'Agent A')
    await waitFor(() => expect(screen.getByTestId('agent-mention-pill')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Remove Agent A' }))
    await waitFor(() => expect(screen.queryByTestId('agent-mention-pill')).toBeNull())
  })

  it('Enter submits and Escape clears, dispatched as real keydown events on the root', () => {
    const { onSubmit, onEscape } = renderInput()
    const root = screen.getByTestId('lexical-composer-input')
    fireEvent.keyDown(root, { key: 'Enter', keyCode: 13 })
    expect(onSubmit).toHaveBeenCalledOnce()
    fireEvent.keyDown(root, { key: 'Escape', keyCode: 27 })
    expect(onEscape).toHaveBeenCalledOnce()
  })

  it('Shift+Enter does not submit', () => {
    const { onSubmit } = renderInput()
    fireEvent.keyDown(screen.getByTestId('lexical-composer-input'), { key: 'Enter', keyCode: 13, shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('disabled makes the root non-editable', () => {
    renderInput({ disabled: true })
    expect(screen.getByTestId('lexical-composer-input').getAttribute('contenteditable')).toBe('false')
  })

  // happy-dom always reports scrollHeight 0, so AutoResizePlugin's resize() lands on
  // MIN_HEIGHT_PX every time - this is the guard against re-clipping line one (a bare
  // textarea line-height is 16px/30px; a smaller MIN_HEIGHT_PX renders it 30px tall).
  it('sizes the empty editor to exactly one line-height', () => {
    renderInput()
    expect(screen.getByTestId('lexical-composer-input').style.height).toBe('30px')
  })
})
