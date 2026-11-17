// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { MapConfig } from '../../../lib/mapSpec.js'
import { parseGeoValue } from './geoValue.js'

export type Bounds = [[number, number], [number, number]]

export type FittedViewState = {
  longitude: number
  latitude: number
  zoom: number
}

const MAX_FIT_ZOOM = 12
const FALLBACK_SIZE = { width: 800, height: 360 }

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function wrapLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

type BoundsAccumulator = {
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
  seen: boolean
}

function newAccumulator(): BoundsAccumulator {
  return { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity, seen: false }
}

function extend(acc: BoundsAccumulator, lon: unknown, lat: unknown): void {
  if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) return
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return
  acc.minLon = Math.min(acc.minLon, lon)
  acc.maxLon = Math.max(acc.maxLon, lon)
  acc.minLat = Math.min(acc.minLat, lat)
  acc.maxLat = Math.max(acc.maxLat, lat)
  acc.seen = true
}

function toBounds(acc: BoundsAccumulator): Bounds | undefined {
  if (!acc.seen) return undefined
  return [[acc.minLon, acc.minLat], [acc.maxLon, acc.maxLat]]
}

function extendFromCoordinates(acc: BoundsAccumulator, coordinates: unknown): void {
  if (!Array.isArray(coordinates)) return
  if (isFiniteNumber(coordinates[0]) && isFiniteNumber(coordinates[1])) {
    extend(acc, coordinates[0], coordinates[1])
    return
  }
  for (const entry of coordinates) extendFromCoordinates(acc, entry)
}

function extendFromGeometry(acc: BoundsAccumulator, geo: unknown): void {
  const parsed = parseGeoValue(geo)
  if (!parsed) return
  const candidate = parsed as {
    type?: string
    coordinates?: unknown
    geometry?: unknown
    geometries?: unknown[]
  }
  if (candidate.type === 'Feature') {
    extendFromGeometry(acc, candidate.geometry)
    return
  }
  if (Array.isArray(candidate.geometries)) {
    for (const inner of candidate.geometries) extendFromGeometry(acc, inner)
    return
  }
  extendFromCoordinates(acc, candidate.coordinates)
}

export function computeDataBounds(
  data: Record<string, unknown>[] | undefined,
  config: Pick<MapConfig, 'layerType' | 'geoColumn' | 'latColumn' | 'lonColumn'>,
): Bounds | undefined {
  if (!data || data.length === 0) return undefined
  const acc = newAccumulator()
  const { layerType, geoColumn, latColumn, lonColumn } = config

  if (layerType === 'latlon') {
    if (!latColumn || !lonColumn) return undefined
    for (const row of data) extend(acc, row[lonColumn], row[latColumn])
  } else if (layerType === 'h3') {
    // Hex outline fitting needs h3-js; skip rather than guess a cell centre.
    return undefined
  } else {
    if (!geoColumn) return undefined
    for (const row of data) extendFromGeometry(acc, row[geoColumn])
  }

  return toBounds(acc)
}

/** Simple mercator-ish fit that does not import deck.gl (keeps tests / CSP-less paths light). */
export function fitViewState(
  bounds: Bounds | undefined,
  width?: number,
  height?: number,
): FittedViewState | undefined {
  if (!bounds) return undefined
  const viewportWidth = width && width > 0 ? width : FALLBACK_SIZE.width
  const viewportHeight = height && height > 0 ? height : FALLBACK_SIZE.height
  const [[minLon, minLat], [maxLon, maxLat]] = bounds
  const longitude = wrapLongitude((minLon + maxLon) / 2)
  const latitude = (minLat + maxLat) / 2
  const spanLon = Math.max(maxLon - minLon, 1e-4)
  const spanLat = Math.max(maxLat - minLat, 1e-4)
  const zoomLon = Math.log2((360 * viewportWidth) / (256 * spanLon * 1.3))
  const zoomLat = Math.log2((180 * viewportHeight) / (256 * spanLat * 1.3))
  const zoom = Math.max(0, Math.min(MAX_FIT_ZOOM, Math.min(zoomLon, zoomLat)))
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !Number.isFinite(zoom)) return undefined
  return { longitude, latitude, zoom }
}
