// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * MapSpec v1 contract — the Cortex `data_to_map` / `response.map` payload.
 * This is a deck.gl document, not Vega-Lite. Handing it to vega-embed throws
 * (`spec.layer is not iterable`) because `layer` is a single object here.
 */

export type MapLayerType = 'latlon' | 'geojson' | 'h3'
export type MapColorScheme = 'categorical' | 'sequential' | 'divergent' | 'snowflake'

export type MapViewState = {
  latitude: number
  longitude: number
  zoom: number
  pitch?: number
  bearing?: number
}

export type MapSpec = {
  version: 1
  title?: string
  viewState?: MapViewState
  layer: {
    type: MapLayerType
    encoding: {
      geoColumn?: string
      h3Column?: string
      latColumn?: string
      lonColumn?: string
      colorColumn?: string
      colorScheme?: MapColorScheme
    }
    styling?: {
      opacity?: number
      pointRadius?: number
      strokeWidth?: number
      filled?: boolean
      stroked?: boolean
    }
    basemap?: { enabled?: boolean }
  }
  data?: { values: Record<string, unknown>[] }
}

export type MapConfig = {
  layerType: MapLayerType
  geoColumn: string
  latColumn?: string
  lonColumn?: string
  colorColumn?: string
  colorScheme: MapColorScheme
  viewState?: { longitude: number; latitude: number; zoom: number }
  opacity?: number
  pointRadius?: number
  strokeWidth?: number
  filled?: boolean
  stroked?: boolean
  showBasemap?: boolean
}

export const MAP_SPEC_USERMETA_KEY = 'snowflakeMapSpec'

export function isMapSpec(obj: unknown): obj is MapSpec {
  return (
    obj != null
    && typeof obj === 'object'
    && 'version' in obj
    && (obj as MapSpec).version === 1
    && 'layer' in obj
    && typeof (obj as MapSpec).layer === 'object'
    && (obj as MapSpec).layer != null
    && typeof (obj as MapSpec).layer.type === 'string'
  )
}

export function mapSpecToMapConfig(spec: MapSpec): MapConfig {
  const { layer, viewState } = spec
  const { encoding, styling } = layer

  let geoColumn: string
  if (layer.type === 'h3') geoColumn = encoding.h3Column ?? encoding.geoColumn ?? ''
  else if (layer.type === 'latlon') geoColumn = encoding.latColumn ?? ''
  else geoColumn = encoding.geoColumn ?? ''

  return {
    layerType: layer.type,
    geoColumn,
    latColumn: encoding.latColumn,
    lonColumn: encoding.lonColumn,
    colorColumn: encoding.colorColumn,
    colorScheme: encoding.colorScheme ?? 'sequential',
    viewState: viewState
      ? { longitude: viewState.longitude, latitude: viewState.latitude, zoom: viewState.zoom }
      : undefined,
    opacity: styling?.opacity,
    pointRadius: styling?.pointRadius,
    strokeWidth: styling?.strokeWidth,
    filled: styling?.filled,
    stroked: styling?.stroked,
    showBasemap: layer.basemap?.enabled ?? true,
  }
}

/**
 * Resolve a MapSpec from either a bare `{version:1, layer}` document or a Vega
 * wrapper that stashes it at `usermeta.snowflakeMapSpec`. A leftover MapSpec
 * on a chart that declared a different `snowflake.chartType` is ignored.
 */
export function resolveMapSpec(spec: unknown): MapSpec | undefined {
  if (isMapSpec(spec)) return spec
  if (spec == null || typeof spec !== 'object') return undefined
  const meta = (spec as { usermeta?: Record<string, unknown> }).usermeta
  if (meta == null || typeof meta !== 'object') return undefined
  const snowflake = meta.snowflake as { chartType?: string } | undefined
  const declaredType = snowflake?.chartType
  if (declaredType != null && declaredType !== 'map') return undefined
  const wrapped = meta[MAP_SPEC_USERMETA_KEY]
  return isMapSpec(wrapped) ? wrapped : undefined
}
