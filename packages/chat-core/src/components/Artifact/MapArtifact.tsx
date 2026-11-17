// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useState, type ComponentType, type CSSProperties } from 'react'
import { useTheme } from '../../lib/themeContext.js'
import { mapSpecToMapConfig, type MapColorScheme, type MapSpec } from '../../lib/mapSpec.js'
import { CartoBasemap } from './map/CartoBasemap.js'
import { getDatavizPalette, hexToRgba, type LegendInfo } from './map/dataviz.js'
import { computeDataBounds, fitViewState } from './map/fitToData.js'
import { parseGeoValue } from './map/geoValue.js'

const DEFAULT_VIEW_STATE = { longitude: 0, latitude: 20, zoom: 1, pitch: 0, bearing: 0 }
const DEFAULT_FILL: [number, number, number, number] = [0, 128, 255, 160]
const FILL_ALPHA = 200 / 255

type ColorAccessor =
  | [number, number, number, number]
  | ((d: Record<string, unknown>) => [number, number, number, number])

function getColorResult(
  data: Record<string, unknown>[],
  colorColumn: string | undefined,
  colorScheme: MapColorScheme,
  themeMode: 'light' | 'dark',
): { accessor: ColorAccessor; legend: LegendInfo | null } {
  if (!colorColumn) return { accessor: DEFAULT_FILL, legend: null }
  const palette = getDatavizPalette(themeMode)
  const values = data.map((row) => row[colorColumn]).filter((v) => v != null)
  if (values.length === 0) return { accessor: DEFAULT_FILL, legend: null }

  if (colorScheme === 'categorical' || typeof values[0] !== 'number') {
    const rgbPalette = palette.categorical.map((hex) => hexToRgba(hex, FILL_ALPHA))
    const uniqueValues = [...new Set(values.map(String))]
    const colorMap = new Map<string, [number, number, number, number]>()
    const legendEntries: { label: string; color: string }[] = []
    uniqueValues.forEach((val, i) => {
      const idx = i % rgbPalette.length
      colorMap.set(val, rgbPalette[idx])
      if (i < 8) legendEntries.push({ label: val, color: palette.categorical[idx] })
    })
    return {
      accessor: (d) => colorMap.get(String(d[colorColumn] ?? '')) ?? [128, 128, 128, 100],
      legend: { type: 'categorical', entries: legendEntries },
    }
  }

  let min = Infinity
  let max = -Infinity
  for (const v of values as number[]) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min || 1
  const hexPalette = colorScheme === 'divergent'
    ? palette.diverging
    : colorScheme === 'snowflake' ? palette.snowflake : palette.sequential
  const rgbPalette = hexPalette.map((hex) => hexToRgba(hex, FILL_ALPHA))
  return {
    accessor: (d) => {
      const val = d[colorColumn] as number
      if (val == null) return [128, 128, 128, 100]
      const t = (val - min) / range
      const idx = Math.min(Math.floor(t * rgbPalette.length), rgbPalette.length - 1)
      return rgbPalette[idx]
    },
    legend: { type: 'sequential', min, max, label: colorColumn, colors: hexPalette },
  }
}

const compactFormatter = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

function MapLegend({ legend }: { legend: LegendInfo }) {
  if (legend.type === 'sequential') {
    return (
      <div className="map-legend">
        <div className="map-legend-title">{legend.label}</div>
        <div className="map-legend-gradient" style={{ background: `linear-gradient(to right, ${legend.colors.join(', ')})` }} />
        <div className="map-legend-labels">
          <span>{compactFormatter.format(legend.min)}</span>
          <span>{compactFormatter.format(legend.max)}</span>
        </div>
      </div>
    )
  }
  return (
    <div className="map-legend">
      <div className="map-legend-cat-list">
        {legend.entries.map((entry) => (
          <div key={entry.label} className="map-legend-cat-item">
            <div className="map-legend-swatch" style={{ backgroundColor: entry.color }} />
            <span>{entry.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function MapCanvas({ spec }: { spec: MapSpec }) {
  const theme = useTheme()
  const isDark = theme === 'dark' || theme === 'contrast'
  const themeMode = isDark ? 'dark' as const : 'light' as const
  const mapConfig = useMemo(() => mapSpecToMapConfig(spec), [spec])
  const data = useMemo(() => spec.data?.values ?? [], [spec])
  const [basemapOk, setBasemapOk] = useState(mapConfig.showBasemap !== false)
  const [deckReady, setDeckReady] = useState(false)
  const [deckFailed, setDeckFailed] = useState(false)
  const [userViewState, setUserViewState] = useState<typeof DEFAULT_VIEW_STATE | undefined>()
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | undefined>()
  const [DeckGL, setDeckGL] = useState<ComponentType<Record<string, unknown>> | null>(null)
  const [layers, setLayers] = useState<unknown[]>([])

  const {
    layerType, geoColumn, latColumn, lonColumn, colorColumn, colorScheme,
    viewState, opacity = 0.8, pointRadius = 6, strokeWidth = 1,
    filled = true, stroked = true, showBasemap = true,
  } = mapConfig

  const dataBounds = useMemo(
    () => computeDataBounds(data, { layerType, geoColumn, latColumn, lonColumn }),
    [data, layerType, geoColumn, latColumn, lonColumn],
  )
  const fitted = useMemo(
    () => fitViewState(dataBounds, viewportSize?.width, viewportSize?.height),
    [dataBounds, viewportSize?.width, viewportSize?.height],
  )
  const resolvedViewState = useMemo(
    () => ({ ...DEFAULT_VIEW_STATE, ...(viewState ?? fitted) }),
    [viewState, fitted],
  )
  const currentViewState = userViewState ?? resolvedViewState
  const colorResult = useMemo(
    () => getColorResult(data, colorColumn, colorScheme, themeMode),
    [data, colorColumn, colorScheme, themeMode],
  )

  const handleUnavailable = useCallback(() => setBasemapOk(false), [])

  // Dynamic-import deck.gl so happy-dom and hosts that never render a map stay light.
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      import('@deck.gl/react'),
      import('@deck.gl/core'),
      import('@deck.gl/layers'),
      import('@deck.gl/geo-layers'),
    ]).then(([{ default: Deck }, { MapView }, { ScatterplotLayer, GeoJsonLayer }, { H3HexagonLayer }]) => {
      if (cancelled) return
      const fillColor = colorResult.accessor
      const strokeColor = hexToRgba(getDatavizPalette(themeMode).referenceLine, 0.5)
      const built: unknown[] = []
      if (layerType === 'latlon' && latColumn && lonColumn) {
        built.push(new ScatterplotLayer({
          id: 'latlon-layer',
          data,
          getPosition: (d: Record<string, unknown>) => [d[lonColumn] as number, d[latColumn] as number],
          getFillColor: fillColor as ColorAccessor,
          getLineColor: strokeColor,
          getRadius: pointRadius,
          radiusUnits: 'pixels',
          radiusMinPixels: 2,
          radiusMaxPixels: 50,
          opacity,
          filled,
          stroked,
          lineWidthMinPixels: stroked ? 1 : 0,
          pickable: true,
        }))
      } else if (layerType === 'h3') {
        built.push(new H3HexagonLayer({
          id: 'h3-layer',
          data,
          getHexagon: (d: Record<string, unknown>) => d[geoColumn] as string,
          getFillColor: fillColor as ColorAccessor,
          getLineColor: strokeColor,
          lineWidthMinPixels: stroked ? 1 : 0,
          opacity,
          filled,
          stroked,
          extruded: false,
          pickable: true,
        }))
      } else {
        const features = data.map((row) => {
          const geo = parseGeoValue(row[geoColumn])
          if (!geo) return null
          if (geo.type === 'Feature') return geo
          if (geo.type) return { type: 'Feature', geometry: geo, properties: row }
          return null
        }).filter((f): f is Record<string, unknown> => f != null)
        built.push(new GeoJsonLayer({
          id: 'data-layer',
          data: { type: 'FeatureCollection', features } as never,
          getFillColor: (f: { properties?: Record<string, unknown> }) => (
            typeof fillColor === 'function' ? fillColor(f.properties ?? {}) : fillColor
          ),
          getLineColor: strokeColor,
          getPointRadius: pointRadius * 30,
          pointRadiusMinPixels: Math.max(2, pointRadius / 2),
          pointRadiusMaxPixels: pointRadius * 5,
          lineWidthMinPixels: Math.max(1, strokeWidth),
          opacity,
          stroked,
          filled,
          pickable: true,
        }))
      }
      setLayers(built)
      setDeckGL(() => (props: Record<string, unknown>) => (
        <Deck {...props} views={new MapView({ repeat: true })} />
      ))
      setDeckReady(true)
    }).catch(() => {
      if (!cancelled) setDeckFailed(true)
    })
    return () => { cancelled = true }
  }, [spec, themeMode, layerType, geoColumn, latColumn, lonColumn, colorColumn, colorScheme, opacity, pointRadius, strokeWidth, filled, stroked, data, colorResult])

  const getTooltip = useCallback(({ object }: { object?: Record<string, unknown> }) => {
    if (!object) return null
    const props = (object as { properties?: Record<string, unknown> }).properties ?? object
    const skip = new Set([geoColumn, '__source'])
    const entries = Object.entries(props).filter(([k]) => !skip.has(k)).slice(0, 6)
    if (entries.length === 0) return null
    return { text: entries.map(([k, v]) => `${k}: ${v}`).join('\n') }
  }, [geoColumn])

  if (deckFailed) {
    return <div className="map-artifact artifact-placeholder">Unable to display map</div>
  }

  const bg: CSSProperties = { backgroundColor: isDark ? '#1a1a1a' : '#f5f5f5' }

  return (
    <div
      className="map-artifact-inner"
      style={bg}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {showBasemap && basemapOk ? (
        <CartoBasemap viewState={currentViewState} isDarkMode={isDark} onUnavailable={handleUnavailable} />
      ) : (
        <div className="map-nobasemap" style={bg} />
      )}
      {DeckGL && (
        <DeckGL
          viewState={currentViewState}
          onViewStateChange={({ viewState: next }: { viewState: typeof DEFAULT_VIEW_STATE }) => setUserViewState(next)}
          onResize={(size: { width: number; height: number }) => setViewportSize(size)}
          controller
          layers={layers}
          getTooltip={getTooltip}
        />
      )}
      {!deckReady && <div className="artifact-placeholder">Loading map…</div>}
      {colorResult.legend && <MapLegend legend={colorResult.legend} />}
      <button
        type="button"
        className="map-fit-btn"
        title="Fit to data"
        aria-label="Fit to data"
        onClick={(e) => { e.stopPropagation(); setUserViewState(undefined) }}
      >
        Fit
      </button>
      {showBasemap && basemapOk && (
        <div className="map-attribution">
          <a href="https://carto.com/" target="_blank" rel="noopener noreferrer">© CARTO</a>
          {' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a>
        </div>
      )}
    </div>
  )
}

interface Props {
  spec: MapSpec
}

export function MapArtifact({ spec }: Props) {
  if (!spec) {
    return (
      <div className="map-artifact artifact-placeholder">
        Map not restored — refresh this thread to reload it.
      </div>
    )
  }
  return (
    <div className="map-artifact">
      {spec.title && <div className="map-artifact-title">{spec.title}</div>}
      <MapCanvas spec={spec} />
    </div>
  )
}
