// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/* eslint-disable @typescript-eslint/no-explicit-any */
// Visual best-practice normalizer for agent-generated Vega-Lite specs. Pure, mutates the
// (already cloned) spec. Rules deliberately override what the agent sent: bars/areas never
// start above zero, no mark is clipped at a scale edge, categories/legends stay legible.
type Node = Record<string, any>

const ZERO_BASED_MARKS = new Set(['bar', 'area'])
const POINT_MARKS = new Set(['point', 'circle', 'square'])
const FOLD_MARKS = new Set(['bar', 'area', 'arc', ...POINT_MARKS])
const MAX_CATEGORIES = 8
const MAX_PIE_SLICES = 6
const OVERPLOT_ROWS = 2000
const OVERPLOT_OPACITY = 0.6
const LABEL_LIMIT = 120
const LEGEND_LABEL_LIMIT = 140
const SCALE_PADDING_PX = 12
const BUBBLE_PADDING_PX = 24
const BUBBLE_SIZE_RANGE = [30, 700]
const TIMEISH = /date|time|day|week|month|quarter|year|period/i
export const OTHER_LABEL = 'Other'
export const NON_ZERO_HINT = ' (axis does not start at 0)'

function isObj(v: unknown): v is Node {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function markType(node: Node): string | undefined {
  const m = node.mark
  if (typeof m === 'string') return m
  return isObj(m) && typeof m.type === 'string' ? m.type : undefined
}

function ensureMarkObject(node: Node): Node {
  if (typeof node.mark === 'string') node.mark = { type: node.mark }
  return node.mark
}

function ensureScale(ch: Node): Node {
  if (!isObj(ch.scale)) ch.scale = {}
  return ch.scale
}

function startsAboveZero(domain: unknown): boolean {
  return Array.isArray(domain) && typeof domain[0] === 'number' && domain[0] > 0
}

function fixZeroBaseline(ch: Node): void {
  if (!isObj(ch) || ch.type !== 'quantitative' || ch.bin) return
  const scale = ensureScale(ch)
  scale.zero = true
  if (startsAboveZero(scale.domain)) delete scale.domain
  if (typeof scale.domainMin === 'number' && scale.domainMin > 0) delete scale.domainMin
}

function padContinuous(ch: Node, pad: number): void {
  if (!isObj(ch) || ch.type !== 'quantitative' || ch.bin) return
  const scale = ensureScale(ch)
  if (scale.nice === undefined) scale.nice = true
  if (scale.padding === undefined) scale.padding = pad
  const title = ch.axis === null ? undefined : ch.title ?? (isObj(ch.axis) ? ch.axis.title : undefined)
  const nonZero = scale.zero === false || startsAboveZero(scale.domain)
  if (nonZero && typeof title === 'string' && !title.endsWith(NON_ZERO_HINT)) {
    if (typeof ch.title === 'string') ch.title = title + NON_ZERO_HINT
    else if (isObj(ch.axis)) ch.axis.title = title + NON_ZERO_HINT
  }
}

function distinct(values: unknown[], field: string): Set<unknown> {
  const out = new Set<unknown>()
  for (const v of values) if (isObj(v)) out.add(v[field])
  return out
}

function foldTail(node: Node, mark: string, values: unknown[]): void {
  const color = node.encoding?.color
  if (!isObj(color) || color.type !== 'nominal' || typeof color.field !== 'string') return
  const field = color.field
  const limit = mark === 'arc' ? MAX_PIE_SLICES : MAX_CATEGORIES
  const keys = distinct(values, field)
  if (keys.size <= limit + 1) return

  const enc = node.encoding
  const measure = ['theta', 'y', 'x', 'size']
    .map((c) => enc[c])
    .find((c) => isObj(c) && c.type === 'quantitative' && typeof c.field === 'string' && c.aggregate !== 'count')
  const weight = new Map<unknown, number>()
  for (const v of values) {
    if (!isObj(v)) continue
    const w = measure ? Math.abs(Number(v[measure.field])) || 0 : 1
    weight.set(v[field], (weight.get(v[field]) ?? 0) + w)
  }
  const keep = new Set(
    [...weight.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k),
  )
  for (const v of values) {
    if (isObj(v) && !keep.has(v[field])) v[field] = OTHER_LABEL
  }
  if (isObj(color.scale)) delete color.scale.domain
}

function normalizeUnit(node: Node): void {
  const mark = markType(node)
  const enc = isObj(node.encoding) ? node.encoding : undefined
  if (!mark || !enc) return
  const values: unknown[] | undefined = isObj(node.data) && Array.isArray(node.data.values) ? node.data.values : undefined

  if (isObj(node.mark) && node.mark.clip === true) node.mark.clip = false

  for (const name of ['x', 'y'] as const) {
    const ch = enc[name]
    if (!isObj(ch)) continue
    if (ZERO_BASED_MARKS.has(mark)) fixZeroBaseline(ch)
    else padContinuous(ch, isObj(enc.size) ? BUBBLE_PADDING_PX : SCALE_PADDING_PX)
    if (ch.axis !== null) {
      const axis = isObj(ch.axis) ? ch.axis : (ch.axis = {})
      if (axis.labelLimit === undefined) axis.labelLimit = LABEL_LIMIT
      if (name === 'x' && ch.type === 'nominal' && values && axis.labelAngle === undefined
        && typeof ch.field === 'string' && distinct(values, ch.field).size > MAX_CATEGORIES) {
        axis.labelAngle = -45
      }
    }
  }

  // Sort nominal categories by value (bars only; never time-like fields or an explicit sort).
  if (mark === 'bar') {
    const [cat, meas] = isObj(enc.x) && enc.x.type === 'nominal' ? ['x', 'y'] : ['y', 'x']
    const c = enc[cat]
    const m = enc[meas]
    if (isObj(c) && isObj(m) && c.type === 'nominal' && m.type === 'quantitative'
      && !('sort' in c) && !c.timeUnit && !(typeof c.field === 'string' && TIMEISH.test(c.field))) {
      c.sort = `-${meas}`
    }
  }

  // Bubble sizing: area-proportional needs a zero origin; bound the glyph range and legend length.
  if (isObj(enc.size) && enc.size.type === 'quantitative') {
    const scale = ensureScale(enc.size)
    scale.zero = true
    if (scale.range === undefined) scale.range = BUBBLE_SIZE_RANGE
    if (enc.size.legend !== null) {
      const legend = isObj(enc.size.legend) ? enc.size.legend : (enc.size.legend = {})
      if (legend.tickCount === undefined) legend.tickCount = 4
    }
  }

  for (const name of ['color', 'size', 'shape', 'opacity']) {
    const ch = enc[name]
    if (!isObj(ch) || ch.legend === null) continue
    const legend = isObj(ch.legend) ? ch.legend : (ch.legend = {})
    if (legend.labelLimit === undefined) legend.labelLimit = LEGEND_LABEL_LIMIT
  }

  if (values && FOLD_MARKS.has(mark)) foldTail(node, mark, values)

  if (values && POINT_MARKS.has(mark) && values.length > OVERPLOT_ROWS) {
    const m = ensureMarkObject(node)
    if (m.opacity === undefined) m.opacity = OVERPLOT_OPACITY
  }
}

export function normalizeChartSpec(node: Node): void {
  if (!isObj(node)) return
  if ('mark' in node) normalizeUnit(node)
  for (const key of ['layer', 'hconcat', 'vconcat', 'concat'] as const) {
    if (Array.isArray(node[key])) node[key].forEach((child: Node) => normalizeChartSpec(child))
  }
  if (isObj(node.spec)) normalizeChartSpec(node.spec)
}
