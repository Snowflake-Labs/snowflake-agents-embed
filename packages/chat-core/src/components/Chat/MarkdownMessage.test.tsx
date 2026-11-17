// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { MarkdownMessage } from './MarkdownMessage'

describe('MarkdownMessage', () => {
  it('does not render javascript: or data: links as anchors while streaming', () => {
    const { container } = render(
      <MarkdownMessage
        streaming
        text={'[x](javascript:alert(1)) and [y](data:text/html,hi)'}
      />,
    )
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('x')
    expect(container.textContent).toContain('y')
  })

  it('does not render javascript: or data: links as anchors after the turn finishes', () => {
    const { container } = render(
      <MarkdownMessage text={'[x](javascript:alert(1)) and [y](data:text/html,hi)'} />,
    )
    expect(container.querySelector('a')).toBeNull()
  })

  it('keeps http(s) links with noopener noreferrer', () => {
    const { container } = render(
      <MarkdownMessage text={'See [docs](https://example.com/a) and [insecure](http://example.com/b)'} />,
    )
    const links = [...container.querySelectorAll('a')]
    expect(links).toHaveLength(2)
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/a',
      'http://example.com/b',
    ])
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })
})
