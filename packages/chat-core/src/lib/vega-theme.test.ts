// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { getMinHeightForHorizontalBar, injectTheme } from './vega-theme'

const FIT_X = { type: 'fit-x', contains: 'padding' }

describe('injectTheme', () => {
  it('merges config into spec without mutating original', () => {
    const spec = { mark: 'bar' }
    const result = injectTheme(spec, 'dark')
    expect(result).not.toBe(spec)
    expect((result as any).config).toBeDefined()
    expect((result as any).config.background).toBeDefined()
  })

  it('makes a single-view spec fill width with fit-x (legend does not pack plot height)', () => {
    const result = injectTheme({ mark: 'bar' }, 'default') as any
    expect(result.width).toBe('container')
    expect(result.height).toBe(300)
    expect(result.autosize).toEqual(FIT_X)
  })

  it('respects an explicit height on a single-view spec when it is taller than the slot', () => {
    const result = injectTheme({ mark: 'bar', height: 500 }, 'default') as any
    expect(result.width).toBe('container')
    expect(result.height).toBe(500)
  })

  it('overrides a fixed pixel width on a single-view spec', () => {
    const result = injectTheme({ mark: 'line', width: 800 }, 'default') as any
    expect(result.width).toBe('container')
  })

  it('fills the container for a layer spec (valid at the layer level)', () => {
    const result = injectTheme({ layer: [{ mark: 'line' }, { mark: 'point' }] }, 'default') as any
    expect(result.width).toBe('container')
    expect(result.autosize).toEqual(FIT_X)
  })

  it('strips fixed width and makes children responsive for a concat spec', () => {
    const result = injectTheme(
      { hconcat: [{ mark: 'line', width: 400 }, { mark: 'bar' }], width: 900 },
      'default',
    ) as any
    expect(result.width).toBeUndefined()
    expect(result.autosize).toEqual(FIT_X)
    expect(result.hconcat[0].width).toBe('container')
    expect(result.hconcat[1].width).toBe('container')
  })

  it('makes the inner spec of a facet responsive', () => {
    const result = injectTheme(
      { facet: { field: 'g', type: 'nominal' }, spec: { mark: 'line', width: 300 } },
      'default',
    ) as any
    expect(result.width).toBeUndefined()
    expect(result.spec.width).toBe('container')
  })

  it('uses a numeric container width when provided', () => {
    const out = injectTheme({ mark: 'bar' }, 'default', 640) as any
    expect(out.width).toBe(640)
    expect(out.autosize).toEqual(FIT_X)
  })

  it('subtracts legend overhead from a measured slot height', () => {
    const out = injectTheme({ mark: 'line' }, 'default', 640, 320) as any
    expect(out.height).toBe(280)
    expect(out.autosize).toEqual(FIT_X)
  })

  it('passes a numeric width down to concat children', () => {
    const out = injectTheme({ hconcat: [{ mark: 'line' }, { mark: 'bar' }] }, 'default', 500) as any
    expect(out.width).toBeUndefined()
    expect(out.hconcat[0].width).toBe(500)
    expect(out.hconcat[1].width).toBe(500)
  })

  it('falls back to container width when no numeric width is given', () => {
    const out = injectTheme({ mark: 'bar' }, 'default') as any
    expect(out.width).toBe('container')
  })

  it('still merges theme config colors', () => {
    const out = injectTheme({ mark: 'line' } as any, 'dark') as any
    expect(out.config.background).toBe('#1f1f1f')
    expect(out.config.axis.labelColor).toBe('#adadad')
  })

  it('defaults legends to the top, matching Intelligence ChartViewer', () => {
    const out = injectTheme({ mark: 'line' }, 'default') as any
    expect(out.config.legend.orient).toBe('top')
    expect(out.config.legend.direction).toBe('horizontal')
  })

  it('lets a spec override the legend orientation', () => {
    const out = injectTheme({ mark: 'line', config: { legend: { orient: 'right' } } }, 'default') as any
    expect(out.config.legend.orient).toBe('right')
  })

  it('skips the Stellar overlay when usermeta["ui-merge"] is none, but still fits the width', () => {
    const out = injectTheme({
      mark: 'bar',
      usermeta: { 'ui-merge': 'none', 'ui-color-scheme': 'light', 'ui-config-dark': { background: '#111' } },
      config: { background: '#fafafa', range: { category: ['#abc'] } },
    }, 'dark', 400) as any
    expect(out.config.background).toBe('#111')
    expect(out.config.range).toBeUndefined()
    expect(out.width).toBe(400)
    expect(out.autosize).toEqual(FIT_X)
  })

  it('uses the Stellar categorical ramp when style merge is on', () => {
    const out = injectTheme({ mark: 'bar' }, 'default') as any
    expect(out.config.range.category[0]).toBe('#1a6ce7')
    expect(out.config.range.diverging[0]).toBe('#002c6e')
    expect(out.config.range.diverging.at(-1)).toBe('#66000e')
    expect(out.config.axis.domain).toBe(false)
    expect(out.config.axis.ticks).toBe(false)
    expect(out.config.bar.cornerRadiusEnd).toBe(4)
  })

  it('lets Stellar range.category win over a Cortex config.range', () => {
    const out = injectTheme({
      mark: 'bar',
      config: { range: { category: ['#ff0000', '#00ff00'] } },
    }, 'default') as any
    expect(out.config.range.category[0]).toBe('#1a6ce7')
  })

  it('remaps a quantitative redyellowgreen scheme to Stellar diverging (red-blue, not green)', () => {
    const values = [
      { product: 'A', profit: 10000 },
      { product: 'B', profit: -500 },
    ]
    const out = injectTheme({
      mark: 'bar',
      encoding: {
        y: { field: 'product', type: 'nominal' },
        x: { field: 'sales', type: 'quantitative' },
        color: { field: 'profit', type: 'quantitative', scale: { scheme: 'redyellowgreen' } },
      },
      data: { values },
    }, 'default') as any
    expect(out.encoding.color.field).toBe('profit')
    expect(out.encoding.color.scale.scheme).toBeUndefined()
    expect(out.encoding.color.scale.range[0]).toBe('#002c6e')
    expect(out.encoding.color.scale.range.at(-1)).toBe('#66000e')
    expect(out.encoding.color.scale.range).not.toContain('#51caa5')
  })

  it('strips a categorical color scale so config.range.category applies', () => {
    const out = injectTheme({
      mark: 'bar',
      encoding: {
        color: { field: 'region', type: 'nominal', scale: { scheme: 'category10' } },
      },
    }, 'default') as any
    expect(out.encoding.color.field).toBe('region')
    expect(out.encoding.color.scale?.scheme).toBeUndefined()
    expect(out.encoding.color.scale?.range).toBeUndefined()
    expect(out.config.range.category[0]).toBe('#1a6ce7')
  })

  it('does not grow a horizontal-bar height when the container height is larger than the min', () => {
    const values = Array.from({ length: 20 }, (_, i) => ({ product: `P${i}`, sales: i }))
    const spec = {
      mark: 'bar',
      encoding: {
        y: { field: 'product', type: 'nominal' },
        x: { field: 'sales', type: 'quantitative' },
      },
      data: { values },
    }
    expect(getMinHeightForHorizontalBar(spec)).toBe(20 * 25 + 80)
    const a = injectTheme(spec, 'default', 640, 320) as any
    const b = injectTheme(spec, 'default', 640, 4000) as any
    expect(a.height).toBe(580)
    expect(b.height).toBe(580)
    expect(a.autosize).toEqual(FIT_X)
  })
})
