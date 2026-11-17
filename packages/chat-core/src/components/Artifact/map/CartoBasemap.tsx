// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react'

// CARTO GL vector styles are ungated (raster tiles watermark). Stay on the
// tiles.basemaps.cartocdn.com host so a host page's CSP can allow
// `https://*.basemaps.cartocdn.com` for style / TileJSON / .mvt / glyphs / sprites.
const STYLE_LIGHT = 'https://tiles.basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const STYLE_DARK = 'https://tiles.basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

export type CartoBasemapViewState = {
  longitude: number
  latitude: number
  zoom: number
  pitch: number
  bearing: number
}

export function CartoBasemap({
  viewState,
  isDarkMode,
  onUnavailable,
}: {
  viewState: CartoBasemapViewState
  isDarkMode: boolean
  onUnavailable?: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<{ jumpTo: (opts: object) => void; remove: () => void; getCanvas: () => HTMLCanvasElement } | null>(null)
  const viewStateRef = useRef(viewState)
  const styleUrl = isDarkMode ? STYLE_DARK : STYLE_LIGHT

  useEffect(() => {
    viewStateRef.current = viewState
    const map = mapRef.current
    if (!map) return
    const { longitude, latitude, zoom, pitch, bearing } = viewState
    map.jumpTo({ center: [longitude, latitude], zoom, pitch, bearing })
  }, [viewState])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    let cancelled = false
    let map: typeof mapRef.current

    void import('maplibre-gl').then(({ Map }) => {
      if (cancelled) return
      const { longitude, latitude, zoom, pitch, bearing } = viewStateRef.current
      map = new Map({
        container,
        style: styleUrl,
        center: [longitude, latitude],
        zoom,
        pitch,
        bearing,
        interactive: false,
        attributionControl: false,
      }) as NonNullable<typeof mapRef.current>
      const canvas = map.getCanvas()
      canvas.style.position = 'absolute'
      canvas.style.top = '0'
      canvas.style.left = '0'
      mapRef.current = map
    }).catch(() => {
      // CSP, missing WebGL, or a blocked CARTO host — layers still render.
      onUnavailable?.()
    })

    return () => {
      cancelled = true
      mapRef.current = null
      try { map?.remove() } catch { /* already torn down */ }
    }
  }, [styleUrl, onUnavailable])

  return <div ref={containerRef} className="map-basemap" />
}
