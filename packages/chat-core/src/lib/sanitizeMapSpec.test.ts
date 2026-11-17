// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { sanitizeMapSpec } from './sanitizeMapSpec.js'

describe('sanitizeMapSpec', () => {
  it('rejects non-MapSpec input', () => {
    expect(sanitizeMapSpec({ mark: 'bar' })).toBeNull()
    expect(sanitizeMapSpec({ version: 1 })).toBeNull()
  })

  it('keeps version/layer/viewState/inline values and drops remote URLs', () => {
    const cleaned = sanitizeMapSpec({
      version: 1,
      title: 'Stores',
      viewState: { latitude: 40.7, longitude: -74, zoom: 10 },
      layer: {
        type: 'latlon',
        encoding: { latColumn: 'lat', lonColumn: 'lon' },
        styling: { opacity: 0.8, pointRadius: 6 },
      },
      data: {
        values: [
          { lat: 40.7, lon: -74, href: 'https://evil.example/x' },
          { lat: 40.8, lon: -73, geom: { url: 'https://evil.example/g' } },
        ],
      },
    })
    expect(cleaned).toMatchObject({
      version: 1,
      title: 'Stores',
      viewState: { latitude: 40.7, longitude: -74, zoom: 10 },
      layer: { type: 'latlon', encoding: { latColumn: 'lat', lonColumn: 'lon' } },
    })
    expect(cleaned?.data?.values).toEqual([
      { lat: 40.7, lon: -74 },
      { lat: 40.8, lon: -73 },
    ])
  })

  it('rejects an unknown layer type', () => {
    expect(sanitizeMapSpec({
      version: 1,
      layer: { type: 'raster', encoding: {} },
      data: { values: [] },
    })).toBeNull()
  })
})
