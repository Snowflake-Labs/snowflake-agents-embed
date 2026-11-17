// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { columnKind, formatCell, cellMatchesFilter, isNumericColumn } from './tableFormat.js'

describe('columnKind', () => {
  it('classifies Snowflake row types', () => {
    expect(columnKind({ name: 'N', type: 'FIXED' })).toBe('number')
    expect(columnKind({ name: 'N', type: 'NUMBER' })).toBe('number')
    expect(columnKind({ name: 'B', type: 'BOOLEAN' })).toBe('boolean')
    expect(columnKind({ name: 'D', type: 'DATE' })).toBe('date')
    expect(columnKind({ name: 'T', type: 'TIMESTAMP_NTZ' })).toBe('timestamp')
    expect(columnKind({ name: 'S', type: 'TEXT' })).toBe('text')
    expect(isNumericColumn({ name: 'N', type: 'REAL' })).toBe(true)
  })
})

describe('formatCell', () => {
  it('formats numbers with grouping and leaves unparseable text', () => {
    expect(formatCell(1000, { name: 'N', type: 'NUMBER' })).toBe(new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(1000))
    expect(formatCell('abc', { name: 'N', type: 'NUMBER' })).toBe('abc')
  })

  it('formats booleans from native values and strings', () => {
    expect(formatCell(true, { name: 'B', type: 'BOOLEAN' })).toBe('true')
    expect(formatCell('False', { name: 'B', type: 'BOOLEAN' })).toBe('false')
  })

  it('formats ISO dates', () => {
    const out = formatCell('2023-10-11', { name: 'D', type: 'DATE' })
    expect(out).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(2023, 9, 11)))
  })

  it('renders null as empty', () => {
    expect(formatCell(null, { name: 'S', type: 'TEXT' })).toBe('')
  })
})

describe('cellMatchesFilter', () => {
  it('matches formatted or raw text, case-insensitively', () => {
    const col = { name: 'N', type: 'NUMBER' }
    expect(cellMatchesFilter(1000, col, '1,000') || cellMatchesFilter(1000, col, '1000')).toBe(true)
    expect(cellMatchesFilter('Central', { name: 'R', type: 'TEXT' }, 'cen')).toBe(true)
    expect(cellMatchesFilter('Central', { name: 'R', type: 'TEXT' }, 'west')).toBe(false)
    expect(cellMatchesFilter('x', { name: 'R', type: 'TEXT' }, '  ')).toBe(true)
  })
})
