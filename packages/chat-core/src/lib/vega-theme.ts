// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { VegaLiteSpec } from '../types.js'
import { getDatavizPalette } from '../components/Artifact/map/dataviz.js'
import { resolveBackendConfig, shouldSkipStyleMerge, themeToColorScheme } from './chartStyle.js'
import { normalizeChartSpec } from './normalizeChartSpec.js'

/**
 * Stellar-like Vega-Lite config snapshot from Intelligence ChartViewer `useStyles`.
 * Hex values match the current Stellar dataviz categorical tokens (same ramp MapViewer uses).
 */
const CATEGORICAL_LIGHT = [
  '#1a6ce7', '#ecb700', '#51caa5', '#d3132f',
  '#7157f4', '#ff7c1d', '#70ddff', '#d45cff',
  '#085bd7', '#c49a00', '#3aa888', '#a40319',
  '#5340c7', '#cc5a00', '#3db8d4', '#a33acc',
]

const CATEGORICAL_DARK = [
  '#5999f8', '#f8c52a', '#80e3c1', '#ef405e',
  '#a797f8', '#ffc59c', '#9ce7ff', '#e59cff',
  '#86b6fc', '#ecb700', '#51caa5', '#f76a86',
  '#7157f4', '#ff7c1d', '#70ddff', '#d45cff',
]

const MIN_HEIGHT_PER_BAR = 25
const CHART_VERTICAL_OVERHEAD = 80
const CHART_LEGEND_OVERHEAD_PX = 40
const MIN_PLOT_HEIGHT = 80

const DIVERGING_SCHEMES = new Set([
  'redyellowgreen', 'yellowgreenblue', 'spectral', 'pinkyellowgreen',
  'redgrey', 'redblue', 'redgreen', 'brownbluegreen', 'purplegreen',
  'purpleorange', 'blueorange', 'redorangered', 'diverging',
])

const SEQUENTIAL_SCHEMES = new Set([
  'viridis', 'plasma', 'inferno', 'magma', 'cividis', 'turbo',
  'blues', 'oranges', 'purples', 'reds', 'greens', 'greys',
  'tealblues', 'yellowgreen', 'yelloworangered', 'yellowgreenblue',
  'bluegreen', 'bluepurple', 'greenblue', 'orangered', 'purplered',
])

function stellarConfig(theme: string): Record<string, unknown> {
  const dark = theme === 'dark'
  const contrast = theme === 'contrast'
  const text = contrast ? '#ffffff' : dark ? '#adadad' : '#646c7c'
  const title = contrast ? '#ffffff' : dark ? '#ffffff' : '#24272c'
  const grid = contrast ? '#555555' : dark ? '#3d3d3d' : '#e0e0e0'
  const background = contrast ? '#000000' : dark ? '#1f1f1f' : '#ffffff'
  const category = contrast
    ? ['#ffffff', '#00a9e0', '#6db8e3', '#b8dff0', ...CATEGORICAL_DARK.slice(4)]
    : dark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT
  const palette = getDatavizPalette(dark || contrast ? 'dark' : 'light')

  return {
    mark: {
      color: category[0],
      tooltip: true,
      cursor: 'crosshair',
    },
    range: {
      category,
      diverging: palette.diverging,
      ramp: palette.sequential,
      heatmap: palette.sequential,
    },
    title: {
      color: title,
      orient: 'top',
      align: 'left',
      anchor: 'start',
      font: 'Plus Jakarta Sans',
      fontSize: 16,
      fontStyle: 'normal',
      fontWeight: 600,
      offset: 16,
    },
    axis: {
      titleColor: text,
      titleFont: 'Plus Jakarta Sans',
      titleFontSize: 12,
      titleFontWeight: 500,
      titlePadding: 16,
      labelColor: text,
      labelFont: 'Plus Jakarta Sans',
      labelFontSize: 12,
      labelFontWeight: 400,
      labelPadding: 12,
      gridColor: grid,
      domain: false,
      ticks: false,
      labelOverlap: 'greedy',
    },
    axisX: { grid: false },
    legend: {
      titleColor: text,
      labelColor: text,
      orient: 'top',
      direction: 'horizontal',
      labelFontSize: 12,
      labelFontWeight: 400,
      titleFontSize: 12,
      titlePadding: 8,
      labelPadding: 8,
      columnPadding: 8,
      rowPadding: 4,
      padding: 0,
    },
    text: {
      color: title,
      font: 'Plus Jakarta Sans',
      fontSize: 40,
      fontWeight: 600,
    },
    view: { stroke: null },
    background,
    bar: { cornerRadiusEnd: 4 },
    rule: { stroke: contrast ? '#ffffff' : dark ? '#bdc4d5' : '#1e252f' },
  }
}

const FIT_X_AUTOSIZE = { type: 'fit-x', contains: 'padding' } as const

function markTypeOf(mark: unknown): string | undefined {
  if (typeof mark === 'string') return mark
  if (mark != null && typeof mark === 'object' && 'type' in mark) {
    const type = (mark as { type?: unknown }).type
    return typeof type === 'string' ? type : undefined
  }
  return undefined
}

function dataValuesOf(node: Record<string, unknown>): unknown[] | undefined {
  const data = node.data
  if (data != null && typeof data === 'object' && Array.isArray((data as { values?: unknown }).values)) {
    return (data as { values: unknown[] }).values
  }
  return undefined
}

function uniqueYCount(node: Record<string, unknown>, values: unknown[] | undefined): number | null {
  if (markTypeOf(node.mark) !== 'bar') return null
  const encoding = node.encoding as { y?: { type?: string; field?: string } } | undefined
  const y = encoding?.y
  if (!y || typeof y.field !== 'string') return null
  if (y.type !== 'nominal' && y.type !== 'ordinal') return null
  if (!values || values.length === 0) return null
  const unique = new Set(
    values
      .filter((v) => v != null && typeof v === 'object')
      .map((v) => (v as Record<string, unknown>)[y.field!])
      .filter((val) => val !== undefined),
  )
  return unique.size > 1 ? unique.size : null
}

/**
 * For horizontal bar charts, minimum height so every y-category gets a readable
 * bar (25px + 80px overhead). Matches native StellarVegaChart.
 */
export function getMinHeightForHorizontalBar(spec: object): number | null {
  const node = spec as Record<string, unknown>
  const values = dataValuesOf(node)
  const fromUnit = uniqueYCount(node, values)
  if (fromUnit != null) return fromUnit * MIN_HEIGHT_PER_BAR + CHART_VERTICAL_OVERHEAD
  const layers = node.layer
  if (Array.isArray(layers)) {
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object') continue
      const n = uniqueYCount(layer as Record<string, unknown>, values ?? dataValuesOf(layer as Record<string, unknown>))
      if (n != null) return n * MIN_HEIGHT_PER_BAR + CHART_VERTICAL_OVERHEAD
    }
  }
  return null
}

function colorFieldHasNegatives(node: Record<string, unknown>, field: string): boolean {
  const values = dataValuesOf(node)
  if (!values) return false
  return values.some((v) => {
    if (v == null || typeof v !== 'object') return false
    const n = (v as Record<string, unknown>)[field]
    return typeof n === 'number' && n < 0
  })
}

function remapColorEncoding(
  encoding: Record<string, unknown> | undefined,
  node: Record<string, unknown>,
  palette: ReturnType<typeof getDatavizPalette>,
): void {
  if (!encoding || typeof encoding !== 'object') return
  const color = encoding.color
  if (!color || typeof color !== 'object') return
  const c = color as Record<string, unknown>
  const type = c.type
  const scale = (c.scale && typeof c.scale === 'object' ? { ...(c.scale as object) } : {}) as Record<string, unknown>
  const scheme = typeof scale.scheme === 'string' ? scale.scheme.toLowerCase().replace(/[_-]/g, '') : ''
  const field = typeof c.field === 'string' ? c.field : undefined

  if (type === 'quantitative' || type === 'temporal') {
    const namedDiverging = scheme !== '' && (
      DIVERGING_SCHEMES.has(scheme)
      || (scheme.includes('red') && (scheme.includes('green') || scheme.includes('blue') || scheme.includes('yellow')))
    )
    const namedSequential = scheme !== '' && SEQUENTIAL_SCHEMES.has(scheme) && !namedDiverging
    const useDiverging = !namedSequential && (
      namedDiverging
      || scheme.includes('yellowgreen')
      || (field != null && colorFieldHasNegatives(node, field))
    )
    delete scale.scheme
    scale.range = useDiverging ? palette.diverging : palette.sequential
    c.scale = scale
    return
  }

  if (scale.range != null || scale.scheme != null) {
    delete scale.range
    delete scale.scheme
    if (Object.keys(scale).length > 0) c.scale = scale
    else delete c.scale
  }
}

function remapSpecColors(node: Record<string, unknown>, palette: ReturnType<typeof getDatavizPalette>): void {
  if (!node || typeof node !== 'object') return
  remapColorEncoding(node.encoding as Record<string, unknown> | undefined, node, palette)
  const layers = node.layer
  if (Array.isArray(layers)) {
    for (const layer of layers) {
      if (layer && typeof layer === 'object') remapSpecColors(layer as Record<string, unknown>, palette)
    }
  }
  for (const key of ['hconcat', 'vconcat', 'concat'] as const) {
    const arr = node[key]
    if (Array.isArray(arr)) arr.forEach((child) => remapSpecColors(child as Record<string, unknown>, palette))
  }
  if (node.spec && typeof node.spec === 'object') remapSpecColors(node.spec as Record<string, unknown>, palette)
}

function resolvedHeight(
  node: Record<string, unknown>,
  containerHeight: number | undefined,
): number {
  // Horizontal-bar min height is a function of category count, not of the
  // currently painted SVG. Using measured clientHeight here is what made
  // Teams charts grow without bound (SVG is always taller than spec.height).
  const hbar = getMinHeightForHorizontalBar(node)
  if (hbar != null) return hbar
  const slot = containerHeight && containerHeight > 0
    ? Math.max(containerHeight - CHART_LEGEND_OVERHEAD_PX, MIN_PLOT_HEIGHT)
    : 300
  const explicit = typeof node.height === 'number' ? node.height : 0
  return Math.max(slot, explicit)
}

// Recursively make a Vega-Lite spec shrink-to-fit its container so it never overflows
// (and gets clipped) on the right edge. Cortex specs often omit `width` — or set a fixed
// pixel `width` on composite views — which spills past the card.
//
// `autosize: fit` with a fixed height compresses legend + bars + x-labels together
// (Agent Admin ChartViewer). `fit-x` keeps plot height while fitting width.
function makeResponsive(
  node: Record<string, unknown>,
  width: number | 'container',
  height: number,
): void {
  if (!node || typeof node !== 'object') return

  const isUnitOrLayer = 'mark' in node || 'layer' in node
  if (isUnitOrLayer) {
    delete node.width
    node.width = width
    node.height = height
    node.autosize = FIT_X_AUTOSIZE
    return
  }

  delete node.width
  delete node.height
  node.autosize = FIT_X_AUTOSIZE
  for (const key of ['hconcat', 'vconcat', 'concat'] as const) {
    const arr = node[key]
    if (Array.isArray(arr)) arr.forEach((child) => makeResponsive(child as Record<string, unknown>, width, height))
  }
  if (node.spec && typeof node.spec === 'object') makeResponsive(node.spec as Record<string, unknown>, width, height)
}

function mergeConfig(theme: Record<string, unknown>, spec: Record<string, unknown>): Record<string, unknown> {
  const themeRange = (theme.range as object | undefined) ?? {}
  const specRange = (spec.range as object | undefined) ?? {}
  const themeMark = (theme.mark as object | undefined) ?? {}
  const specMark = (spec.mark as object | undefined) ?? {}
  return {
    ...spec,
    ...theme,
    range: { ...specRange, ...themeRange },
    mark: { ...specMark, ...themeMark },
    bar: { ...(spec.bar as object ?? {}), ...(theme.bar as object ?? {}) },
    legend: { ...(theme.legend as object ?? {}), ...(spec.legend as object ?? {}) },
    axis: { ...(theme.axis as object ?? {}), ...(spec.axis as object ?? {}) },
    background: theme.background,
  }
}

// `containerWidth` (px) makes `autosize: fit-x` contain axis labels/legend within that width.
// `containerHeight` (px) is the chat slot; horizontal-bar min height can exceed it.
export function injectTheme(
  spec: VegaLiteSpec,
  theme: string,
  containerWidth?: number,
  containerHeight?: number,
): VegaLiteSpec {
  const themed = structuredClone(spec) as VegaLiteSpec
  const specConfig = (themed.config as Record<string, unknown> | undefined) ?? {}
  const scheme = themeToColorScheme(theme)
  const palette = getDatavizPalette(scheme)

  if (shouldSkipStyleMerge(themed)) {
    themed.config = resolveBackendConfig(themed, scheme)
  } else {
    themed.config = mergeConfig(stellarConfig(theme), specConfig)
    remapSpecColors(themed as unknown as Record<string, unknown>, palette)
  }

  normalizeChartSpec(themed as unknown as Record<string, unknown>)

  const width = containerWidth && containerWidth > 0 ? containerWidth : 'container'
  const height = resolvedHeight(themed as unknown as Record<string, unknown>, containerHeight)
  makeResponsive(themed as unknown as Record<string, unknown>, width, height)
  return themed
}
