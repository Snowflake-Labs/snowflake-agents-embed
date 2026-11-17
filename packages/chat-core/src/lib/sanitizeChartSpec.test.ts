// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { sanitizeChartSpec, VEGA_EMBED_OPTIONS } from './sanitizeChartSpec.js'

describe('sanitizeChartSpec', () => {
  it('rejects a non-object', () => {
    expect(sanitizeChartSpec('vega')).toBeNull()
    expect(sanitizeChartSpec([])).toBeNull()
  })

  it('keeps usermeta (ui-merge / columnTypes / snowflakeMapSpec) and strips embedOptions', () => {
    const cleaned = sanitizeChartSpec({
      mark: 'bar',
      usermeta: {
        'ui-merge': 'none',
        snowflake: { columnTypes: [{ name: 'A', type: 'fixed' }] },
        snowflakeMapSpec: { version: 1, layer: { type: 'latlon' } },
        embedOptions: { mode: 'vega', loader: 'https://evil.example' },
      },
      encoding: { x: { field: 'a' } },
    })
    expect(cleaned).toEqual({
      mark: 'bar',
      usermeta: {
        'ui-merge': 'none',
        snowflake: { columnTypes: [{ name: 'A', type: 'fixed' }] },
        snowflakeMapSpec: { version: 1, layer: { type: 'latlon' } },
      },
      encoding: { x: { field: 'a' } },
    })
  })

  it('strips signals, expr, and remote data urls', () => {
    const cleaned = sanitizeChartSpec({
      mark: 'bar',
      signals: [{ name: 'x' }],
      data: { url: 'https://evil.example/data' },
      encoding: { x: { field: 'a' } },
    })
    expect(cleaned).toEqual({
      mark: 'bar',
      data: {},
      encoding: { x: { field: 'a' } },
    })
  })

  it('keeps axis labelExpr so GBP SI prefixes can still rewrite G to B', () => {
    const cleaned = sanitizeChartSpec({
      mark: 'line',
      encoding: { y: { axis: { labelExpr: "replace(datum.label, 'G', 'B')" } } },
    })
    expect(cleaned).toEqual({
      mark: 'line',
      encoding: { y: { axis: { labelExpr: "replace(datum.label, 'G', 'B')" } } },
    })
  })

  it('embeds with ast:true so Vega expressions stay CSP-compliant', () => {
    expect(VEGA_EMBED_OPTIONS.ast).toBe(true)
    expect(VEGA_EMBED_OPTIONS.mode).toBe('vega-lite')
  })

  it('keeps inline data.values', () => {
    const cleaned = sanitizeChartSpec({
      mark: 'bar',
      data: { values: [{ a: 1 }] },
    })
    expect(cleaned).toEqual({ mark: 'bar', data: { values: [{ a: 1 }] } })
  })
})
