// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MapArtifact } from './MapArtifact'

vi.mock('@deck.gl/react', () => ({ default: () => null }))
vi.mock('@deck.gl/core', () => ({ MapView: class {} }))
vi.mock('@deck.gl/layers', () => ({ ScatterplotLayer: class {}, GeoJsonLayer: class {} }))
vi.mock('@deck.gl/geo-layers', () => ({ H3HexagonLayer: class {} }))
vi.mock('maplibre-gl', () => ({ Map: class { remove() {} getCanvas() { return { style: {} } } jumpTo() {} } }))

describe('MapArtifact', () => {
  it('shows a restore placeholder when the spec was stripped', () => {
    render(<MapArtifact spec={undefined as never} />)
    expect(screen.getByText(/Map not restored/)).toBeTruthy()
  })

  it('renders the map title', () => {
    render(<MapArtifact spec={{
      version: 1,
      title: 'Stores',
      layer: { type: 'latlon', encoding: { latColumn: 'lat', lonColumn: 'lon' } },
      data: { values: [] },
    }} />)
    expect(screen.getByText('Stores')).toBeTruthy()
    expect(document.querySelector('.map-artifact')).toBeTruthy()
  })
})
