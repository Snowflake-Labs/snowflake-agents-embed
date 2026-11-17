// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { firstNameOf } from './firstName'

describe('firstNameOf', () => {
  it('returns undefined for a missing or blank name', () => {
    expect(firstNameOf()).toBeUndefined()
    expect(firstNameOf('')).toBeUndefined()
    expect(firstNameOf('   ')).toBeUndefined()
  })

  it('takes the first token of a full name', () => {
    expect(firstNameOf('Jordan Rivera')).toBe('Jordan')
    expect(firstNameOf('Jordan J. Rivera')).toBe('Jordan')
  })

  it('passes a bare first name through unchanged (the Salesforce case)', () => {
    expect(firstNameOf('jordan')).toBe('jordan')
  })

  it('handles last-name-first display names', () => {
    expect(firstNameOf('Rivera, Jordan')).toBe('Jordan')
  })

  it('trims surrounding whitespace', () => {
    expect(firstNameOf('  Jordan Rivera  ')).toBe('Jordan')
  })
})
