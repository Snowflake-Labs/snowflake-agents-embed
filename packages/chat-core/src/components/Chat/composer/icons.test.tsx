// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  PaperclipIcon, TelescopeIcon, PuzzleIcon, ChevronRightIcon, ChevronDownIcon, PlusIcon,
  InfoIcon, XIcon, GraduationCapIcon, ChatBubbleIcon, AgentIcon, SearchIcon, MenuIcon,
  PinIcon, ArchiveIcon, PencilIcon, TrashIcon, PanelCollapseIcon,
} from './icons'

const ALL_ICONS = {
  PaperclipIcon, TelescopeIcon, PuzzleIcon, ChevronRightIcon, ChevronDownIcon, PlusIcon,
  InfoIcon, XIcon, GraduationCapIcon, ChatBubbleIcon, AgentIcon, SearchIcon, MenuIcon,
  PinIcon, ArchiveIcon, PencilIcon, TrashIcon, PanelCollapseIcon,
}

describe('composer icons', () => {
  it.each(Object.entries(ALL_ICONS))('%s renders a single aria-hidden svg', (_name, Icon) => {
    const { container } = render(<Icon />)
    const svgs = container.querySelectorAll('svg')
    expect(svgs).toHaveLength(1)
    expect(svgs[0].getAttribute('aria-hidden')).toBe('true')
  })

  it.each(Object.entries(ALL_ICONS))('%s forwards className onto the svg', (_name, Icon) => {
    const { container } = render(<Icon className="custom-icon-class" />)
    expect(container.querySelector('svg')?.classList.contains('custom-icon-class')).toBe(true)
  })

  it('defaults to the 16px/sm bucket and thickens stroke-width to compensate', () => {
    const { container } = render(<PuzzleIcon />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('stroke-width')).toBe('2')
  })

  it('picks a lighter stroke-width for the 20px/md bucket', () => {
    const { container } = render(<PuzzleIcon size={20} />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('stroke-width')).toBe('1.75')
  })
})
