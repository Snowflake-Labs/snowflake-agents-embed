// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { isMapSpec, resolveMapSpec, mapSpecToMapConfig } from './mapSpec.js'

const latlon: Record<string, unknown> = {
  version: 1,
  layer: {
    type: 'latlon',
    encoding: { latColumn: 'lat', lonColumn: 'lon', colorColumn: 'revenue', colorScheme: 'sequential' },
    styling: { opacity: 0.8, pointRadius: 8 },
  },
  data: { values: [{ lat: 40.7, lon: -74, revenue: 1 }] },
}

describe('isMapSpec / resolveMapSpec', () => {
  it('accepts a bare MapSpec v1', () => {
    expect(isMapSpec(latlon)).toBe(true)
    expect(resolveMapSpec(latlon)).toEqual(latlon)
  })

  it('rejects Vega-Lite and incomplete objects', () => {
    expect(isMapSpec({ mark: 'bar' })).toBe(false)
    expect(isMapSpec({ version: 1 })).toBe(false)
    expect(resolveMapSpec({ mark: 'bar' })).toBeUndefined()
  })

  it('unwraps usermeta.snowflakeMapSpec when chartType is map or absent', () => {
    const wrapped = { mark: 'geoshape', usermeta: { snowflakeMapSpec: latlon } }
    expect(resolveMapSpec(wrapped)).toEqual(latlon)
    const typed = { usermeta: { snowflake: { chartType: 'map' }, snowflakeMapSpec: latlon } }
    expect(resolveMapSpec(typed)).toEqual(latlon)
  })

  it('ignores a leftover MapSpec when the chart declared a different type', () => {
    const leftover = { mark: 'bar', usermeta: { snowflake: { chartType: 'bar' }, snowflakeMapSpec: latlon } }
    expect(resolveMapSpec(leftover)).toBeUndefined()
  })
})

describe('mapSpecToMapConfig', () => {
  it('maps latlon encoding and styling onto MapConfig', () => {
    expect(mapSpecToMapConfig(latlon as never)).toMatchObject({
      layerType: 'latlon',
      latColumn: 'lat',
      lonColumn: 'lon',
      colorColumn: 'revenue',
      colorScheme: 'sequential',
      opacity: 0.8,
      pointRadius: 8,
      showBasemap: true,
    })
  })

  it('prefers h3Column for h3 layers', () => {
    const spec = {
      version: 1 as const,
      layer: { type: 'h3' as const, encoding: { h3Column: 'h3_cell' } },
    }
    expect(mapSpecToMapConfig(spec).geoColumn).toBe('h3_cell')
  })
})
