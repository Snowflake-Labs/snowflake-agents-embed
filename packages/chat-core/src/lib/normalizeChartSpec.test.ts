// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { normalizeChartSpec, NON_ZERO_HINT, OTHER_LABEL } from './normalizeChartSpec'

const run = (spec: any) => { normalizeChartSpec(spec); return spec }

describe('normalizeChartSpec', () => {
  it('forces a zero baseline on bars and strips a non-zero domain', () => {
    const s = run({
      mark: 'bar',
      encoding: {
        x: { field: 'c', type: 'nominal' },
        y: { field: 'v', type: 'quantitative', scale: { zero: false, domain: [100000, 400000], domainMin: 5 } },
      },
    })
    expect(s.encoding.y.scale.zero).toBe(true)
    expect(s.encoding.y.scale.domain).toBeUndefined()
    expect(s.encoding.y.scale.domainMin).toBeUndefined()
  })

  it('forces zero on area but leaves binned axes alone', () => {
    const s = run({ mark: 'area', encoding: { y: { field: 'v', type: 'quantitative', bin: true } } })
    expect(s.encoding.y.scale).toBeUndefined()
  })

  it('pads scatter axes instead of forcing zero, and flags a non-zero axis', () => {
    const s = run({
      mark: 'point',
      encoding: {
        x: { field: 'r', type: 'quantitative', title: 'Rating', scale: { zero: false } },
        y: { field: 's', type: 'quantitative' },
      },
    })
    expect(s.encoding.x.scale.zero).toBe(false)
    expect(s.encoding.x.scale.nice).toBe(true)
    expect(s.encoding.x.scale.padding).toBe(12)
    expect(s.encoding.x.title).toBe(`Rating${NON_ZERO_HINT}`)
    expect(s.encoding.y.title).toBeUndefined()
  })

  it('bubbles get zero-origin size scale, bounded range, short legend and extra padding', () => {
    const s = run({
      mark: 'circle',
      encoding: {
        x: { field: 'r', type: 'quantitative' },
        y: { field: 's', type: 'quantitative' },
        size: { field: 'n', type: 'quantitative' },
      },
    })
    expect(s.encoding.size.scale).toMatchObject({ zero: true, range: [30, 700] })
    expect(s.encoding.size.legend.tickCount).toBe(4)
    expect(s.encoding.x.scale.padding).toBe(24)
  })

  it('sets label limits, sorts nominal bars by value, respects explicit sort and time-like fields', () => {
    const bar = (field: string, extra: any = {}) => run({
      mark: 'bar',
      encoding: { y: { field, type: 'nominal', ...extra }, x: { field: 'v', type: 'quantitative' } },
    })
    expect(bar('product').encoding.y.sort).toBe('-x')
    expect(bar('product').encoding.y.axis.labelLimit).toBe(120)
    expect(bar('product', { sort: null }).encoding.y.sort).toBeNull()
    expect(bar('order_month').encoding.y.sort).toBeUndefined()
  })

  it('folds a long categorical tail into Other, keeping the biggest contributors', () => {
    const values = Array.from({ length: 12 }, (_, i) => ({ k: `K${i}`, v: 100 - i }))
    const s = run({
      mark: 'bar',
      data: { values },
      encoding: {
        x: { field: 'k', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        color: { field: 'k', type: 'nominal', scale: { domain: ['x'] } },
      },
    })
    const keys = new Set(values.map((v) => v.k))
    expect(keys.size).toBe(MAX + 1)
    expect(keys.has(OTHER_LABEL)).toBe(true)
    expect(keys.has('K0')).toBe(true)
    expect(keys.has('K11')).toBe(false)
    expect(s.encoding.color.scale.domain).toBeUndefined()
  })

  it('uses a smaller slice limit for pies and does not fold lines', () => {
    const vals = () => Array.from({ length: 9 }, (_, i) => ({ k: `K${i}`, v: 10 - i }))
    const pie = vals()
    run({ mark: 'arc', data: { values: pie }, encoding: { theta: { field: 'v', type: 'quantitative' }, color: { field: 'k', type: 'nominal' } } })
    expect(new Set(pie.map((v) => v.k)).size).toBe(7)
    const line = vals()
    run({ mark: 'line', data: { values: line }, encoding: { x: { field: 'k', type: 'nominal' }, color: { field: 'k', type: 'nominal' } } })
    expect(new Set(line.map((v) => v.k)).size).toBe(9)
  })

  it('lowers opacity on overplotted scatter and disables mark clipping', () => {
    const values = Array.from({ length: 2500 }, (_, i) => ({ a: i, b: i }))
    const s = run({ mark: { type: 'point', clip: true }, data: { values }, encoding: { x: { field: 'a', type: 'quantitative' } } })
    expect(s.mark.opacity).toBe(0.6)
    expect(s.mark.clip).toBe(false)
  })

  it('recurses through layer / concat / spec', () => {
    const unit = () => ({ mark: 'bar', encoding: { y: { field: 'v', type: 'quantitative', scale: { domain: [5, 9] } } } })
    const s = run({ vconcat: [{ layer: [unit()] }, { spec: unit() }] })
    expect(s.vconcat[0].layer[0].encoding.y.scale.domain).toBeUndefined()
    expect(s.vconcat[1].spec.encoding.y.scale.zero).toBe(true)
  })
})

const MAX = 8
