// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { shouldSkipStyleMerge, resolveBackendConfig, themeToColorScheme } from './chartStyle.js'

describe('shouldSkipStyleMerge', () => {
  it('is false without usermeta', () => {
    expect(shouldSkipStyleMerge({ mark: 'bar' })).toBe(false)
    expect(shouldSkipStyleMerge(null)).toBe(false)
  })

  it('is true only for usermeta["ui-merge"] === "none"', () => {
    expect(shouldSkipStyleMerge({ usermeta: { 'ui-merge': 'none' } })).toBe(true)
    expect(shouldSkipStyleMerge({ usermeta: { 'ui-merge': 'all' } })).toBe(false)
    expect(shouldSkipStyleMerge({ usermeta: {} })).toBe(false)
  })
})

describe('resolveBackendConfig', () => {
  const spec = {
    config: { background: 'light-bg' },
    usermeta: {
      'ui-color-scheme': 'light',
      'ui-config-dark': { background: 'dark-bg' },
    },
  }

  it('returns spec.config when the scheme matches', () => {
    expect(resolveBackendConfig(spec, 'light')).toEqual({ background: 'light-bg' })
  })

  it('returns the alternate usermeta config when the scheme differs', () => {
    expect(resolveBackendConfig(spec, 'dark')).toEqual({ background: 'dark-bg' })
  })

  it('infers the primary scheme from the alternate key when ui-color-scheme is absent', () => {
    const inferred = {
      config: { background: 'light-bg' },
      usermeta: { 'ui-config-dark': { background: 'dark-bg' } },
    }
    expect(resolveBackendConfig(inferred, 'dark')).toEqual({ background: 'dark-bg' })
    expect(resolveBackendConfig(inferred, 'light')).toEqual({ background: 'light-bg' })
  })
})

describe('themeToColorScheme', () => {
  it('maps embed themes onto light/dark', () => {
    expect(themeToColorScheme('default')).toBe('light')
    expect(themeToColorScheme('dark')).toBe('dark')
    expect(themeToColorScheme('contrast')).toBe('dark')
  })
})
