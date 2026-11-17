// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { isMapSpec, type MapLayerType, type MapSpec } from './mapSpec.js'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function looksLikeUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /^(https?:|data:|\/\/)/i.test(value.trim())
}

const LAYER_TYPES = new Set<MapLayerType>(['latlon', 'geojson', 'h3'])

function scrubRow(row: unknown): Record<string, unknown> | null {
  if (!isPlainObject(row)) return null
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(row)) {
    if (looksLikeUrl(child)) continue
    if (isPlainObject(child) && looksLikeUrl(child.url)) continue
    out[key] = child
  }
  return out
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Keep the MapSpec v1 fields a renderer needs; drop remote URLs so GeoJSON
 * cannot pull attacker-controlled tiles or FeatureCollections.
 */
export function sanitizeMapSpec(raw: unknown): MapSpec | null {
  if (!isMapSpec(raw)) return null
  const type = raw.layer?.type
  if (!LAYER_TYPES.has(type)) return null

  const encodingIn = raw.layer.encoding ?? {}
  const stylingIn = raw.layer.styling ?? {}
  const view = raw.viewState
  const values = Array.isArray(raw.data?.values)
    ? raw.data!.values.map(scrubRow).filter((row): row is Record<string, unknown> => row != null)
    : []

  const lat = asFiniteNumber(view?.latitude)
  const lon = asFiniteNumber(view?.longitude)
  const zoom = asFiniteNumber(view?.zoom)

  return {
    version: 1,
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(lat != null && lon != null && zoom != null
      ? {
          viewState: {
            latitude: lat,
            longitude: lon,
            zoom,
            ...(asFiniteNumber(view?.pitch) != null ? { pitch: view!.pitch } : {}),
            ...(asFiniteNumber(view?.bearing) != null ? { bearing: view!.bearing } : {}),
          },
        }
      : {}),
    layer: {
      type,
      encoding: {
        ...(typeof encodingIn.geoColumn === 'string' ? { geoColumn: encodingIn.geoColumn } : {}),
        ...(typeof encodingIn.h3Column === 'string' ? { h3Column: encodingIn.h3Column } : {}),
        ...(typeof encodingIn.latColumn === 'string' ? { latColumn: encodingIn.latColumn } : {}),
        ...(typeof encodingIn.lonColumn === 'string' ? { lonColumn: encodingIn.lonColumn } : {}),
        ...(typeof encodingIn.colorColumn === 'string' ? { colorColumn: encodingIn.colorColumn } : {}),
        ...(encodingIn.colorScheme === 'categorical'
          || encodingIn.colorScheme === 'sequential'
          || encodingIn.colorScheme === 'divergent'
          || encodingIn.colorScheme === 'snowflake'
          ? { colorScheme: encodingIn.colorScheme }
          : {}),
      },
      styling: {
        ...(asFiniteNumber(stylingIn.opacity) != null ? { opacity: stylingIn.opacity } : {}),
        ...(asFiniteNumber(stylingIn.pointRadius) != null ? { pointRadius: stylingIn.pointRadius } : {}),
        ...(asFiniteNumber(stylingIn.strokeWidth) != null ? { strokeWidth: stylingIn.strokeWidth } : {}),
        ...(asBoolean(stylingIn.filled) != null ? { filled: stylingIn.filled } : {}),
        ...(asBoolean(stylingIn.stroked) != null ? { stroked: stylingIn.stroked } : {}),
      },
      ...(raw.layer.basemap && typeof raw.layer.basemap === 'object'
        ? { basemap: { enabled: raw.layer.basemap.enabled !== false } }
        : {}),
    },
    data: { values },
  }
}
