// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { LexicalComposerInput } from '../LexicalComposerInput'
import type { LexicalComposerInputHandle } from '../LexicalComposerInput'

// Driven through LexicalComposerInput rather than mounting VoiceAppendPlugin in isolation -
// it needs a live LexicalComposerContext, and this is the same harness the sibling plugin
// tests in composer/LexicalComposerInput.test.tsx already use.
function renderInput() {
  const ref = createRef<LexicalComposerInputHandle>()
  const onCommittedTextAppended = vi.fn()
  const view = render(
    <LexicalComposerInput
      ref={ref}
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      onEscape={vi.fn()}
      onPasteFiles={undefined}
      placeholder="Ask anything..."
      isMentionMenuOpen={false}
      committedVoiceText={null}
      onCommittedVoiceTextAppended={onCommittedTextAppended}
      interimVoiceText={null}
    />,
  )
  return { ref, onCommittedTextAppended, rerender: view.rerender }
}

function root() {
  return screen.getByTestId('lexical-composer-input')
}

describe('VoiceAppendPlugin (via LexicalComposerInput)', () => {
  it('renders one interim segment and replaces it in place on revision, not accumulating', async () => {
    const { rerender } = renderInput()
    const props = {
      onChange: vi.fn(), onSubmit: vi.fn(), onEscape: vi.fn(), onPasteFiles: undefined,
      placeholder: 'Ask anything...', isMentionMenuOpen: false,
      committedVoiceText: null, onCommittedVoiceTextAppended: vi.fn(),
    }

    rerender(<LexicalComposerInput {...props} interimVoiceText="show sal" />)
    await waitFor(() => expect(root().textContent).toBe('show sal'))

    // A revision to the same in-progress segment must replace, not append.
    rerender(<LexicalComposerInput {...props} interimVoiceText="show sales" />)
    await waitFor(() => expect(root().textContent).toBe('show sales'))
    expect(root().textContent).not.toContain('show salshow sales')
  })

  it('promotes the interim node to committed text and releases it for the next segment', async () => {
    const onCommittedTextAppended = vi.fn()
    const { rerender } = renderInput()
    const props = {
      onChange: vi.fn(), onSubmit: vi.fn(), onEscape: vi.fn(), onPasteFiles: undefined,
      placeholder: 'Ask anything...', isMentionMenuOpen: false,
    }

    rerender(<LexicalComposerInput {...props} interimVoiceText="show sales" committedVoiceText={null} onCommittedVoiceTextAppended={onCommittedTextAppended} />)
    await waitFor(() => expect(root().textContent).toBe('show sales'))

    rerender(<LexicalComposerInput {...props} interimVoiceText="" committedVoiceText="show sales by region" onCommittedVoiceTextAppended={onCommittedTextAppended} />)
    await waitFor(() => expect(root().textContent).toBe('show sales by region'))
    expect(onCommittedTextAppended).toHaveBeenCalledOnce()

    // A second, unrelated segment starts a fresh node rather than reusing the finalized one.
    rerender(<LexicalComposerInput {...props} interimVoiceText="and prof" committedVoiceText="show sales by region" onCommittedVoiceTextAppended={onCommittedTextAppended} />)
    await waitFor(() => expect(root().textContent).toBe('show sales by region and prof'))
  })

  it('removes the interim node with no trace when the segment is aborted with no final', async () => {
    const { rerender } = renderInput()
    const props = {
      onChange: vi.fn(), onSubmit: vi.fn(), onEscape: vi.fn(), onPasteFiles: undefined,
      placeholder: 'Ask anything...', isMentionMenuOpen: false,
      committedVoiceText: null, onCommittedVoiceTextAppended: vi.fn(),
    }

    rerender(<LexicalComposerInput {...props} interimVoiceText="never mind" />)
    await waitFor(() => expect(root().textContent).toBe('never mind'))

    rerender(<LexicalComposerInput {...props} interimVoiceText={null} />)
    await waitFor(() => expect(root().textContent).toBe(''))
  })

  it('a final promotes cleanly even with no interim node ever having existed', async () => {
    const onCommittedTextAppended = vi.fn()
    const { rerender } = renderInput()
    const props = {
      onChange: vi.fn(), onSubmit: vi.fn(), onEscape: vi.fn(), onPasteFiles: undefined,
      placeholder: 'Ask anything...', isMentionMenuOpen: false, interimVoiceText: null,
    }

    rerender(<LexicalComposerInput {...props} committedVoiceText="show sales" onCommittedVoiceTextAppended={onCommittedTextAppended} />)
    await waitFor(() => expect(root().textContent).toBe('show sales'))
    expect(onCommittedTextAppended).toHaveBeenCalledOnce()
  })
})
