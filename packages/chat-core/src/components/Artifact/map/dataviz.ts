// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
type DatavizPalette = {
  sequential: string[]
  diverging: string[]
  snowflake: string[]
  categorical: string[]
  referenceLine: string
}

const sequential = [
  '#f1f7ff', '#bbd6fe', '#86b6fc', '#5999f8', '#3580f2',
  '#1a6ce7', '#085bd7', '#004cbe', '#003e9a', '#002c6e',
]

const light: DatavizPalette = {
  sequential,
  diverging: [
    '#002c6e', '#004cbe', '#1a6ce7', '#5999f8', '#bbd6fe',
    '#eceef1', '#ffd1dc', '#f76a86', '#d3132f', '#a40319', '#66000e',
  ],
  snowflake: ['#29b5e8', '#0071c5', '#11567f', '#6db8e3'],
  categorical: ['#1a6ce7', '#ecb700', '#51caa5', '#d3132f', '#7157f4', '#ff7c1d', '#70ddff', '#d45cff'],
  referenceLine: '#1e252f',
}

const dark: DatavizPalette = {
  sequential,
  diverging: light.diverging,
  snowflake: ['#29b5e8', '#00a9e0', '#6db8e3', '#b8dff0'],
  categorical: ['#5999f8', '#f8c52a', '#80e3c1', '#ef405e', '#a797f8', '#ffc59c', '#9ce7ff', '#e59cff'],
  referenceLine: '#bdc4d5',
}

export function getDatavizPalette(colorScheme: 'light' | 'dark'): DatavizPalette {
  return colorScheme === 'dark' ? dark : light
}

export function hexToRgba(hex: string, alpha: number): [number, number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
    Math.round(alpha * 255),
  ]
}

export type LegendInfo =
  | { type: 'sequential'; min: number; max: number; label: string; colors: string[] }
  | { type: 'categorical'; entries: { label: string; color: string }[] }
