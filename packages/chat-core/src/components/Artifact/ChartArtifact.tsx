// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react'
import type { VisualizationSpec } from 'vega-embed'
import { exportChart, type ChartExportFormat } from '../../lib/chartExport.js'
import { getMinHeightForHorizontalBar, injectTheme } from '../../lib/vega-theme.js'
import { VEGA_EMBED_OPTIONS } from '../../lib/sanitizeChartSpec.js'
import { applyColumnTypesToSpec } from '../../lib/formatVegaData.js'
import { resolveMapSpec } from '../../lib/mapSpec.js'
import { useTheme } from '../../lib/themeContext.js'
import { MapArtifact } from './MapArtifact.js'

interface Props {
  spec: VisualizationSpec
}

const SLOT_NARROW = 250
const SLOT_WIDE = 320

function slotHeightPx(): number {
  if (typeof window === 'undefined') return SLOT_WIDE
  return window.matchMedia('(min-width: 720px)').matches ? SLOT_WIDE : SLOT_NARROW
}

export function ChartArtifact({ spec }: Props) {
  const theme = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDetailsElement>(null)
  const [ready, setReady] = useState(false)
  const [renderError, setRenderError] = useState(false)
  const [exporting, setExporting] = useState<ChartExportFormat | null>(null)
  const [exportError, setExportError] = useState('')
  const mapSpec = spec ? resolveMapSpec(spec) : undefined
  const hbarMin = useMemo(
    () => (spec && !mapSpec ? getMinHeightForHorizontalBar(spec as object) : null),
    [spec, mapSpec],
  )
  const slot = slotHeightPx()
  const layoutHeight = hbarMin != null && hbarMin > slot ? hbarMin : slot
  // Painted SVG height (plot + legend + axes + title). Used only to size the frame so
  // nothing is clipped — never fed back into the spec, which would loop.
  const [measuredHeight, setMeasuredHeight] = useState(0)
  const frameHeight = Math.max(layoutHeight, measuredHeight)
  const scrollable = frameHeight > slot

  useEffect(() => {
    const container = containerRef.current
    if (!container || !spec || mapSpec) return
    let disposed = false
    let current: { finalize: () => void } | undefined
    let gen = 0
    let lastWidth = 0
    let raf = 0
    setRenderError(false)
    setReady(false)

    // Height is a computed slot (250/320, or 25px/bar for horizontal charts) — never
    // the inner box's clientHeight. Vega's SVG is always a few px taller than the spec
    // height (legend + padding). Measuring that and feeding it back is an unbounded
    // ResizeObserver loop (the chart grew down the page indefinitely).
    const render = () => {
      if (disposed) return
      const width = Math.round(container.clientWidth)
      if (width <= 0) return
      lastWidth = width
      const myGen = ++gen
      const typed = applyColumnTypesToSpec(spec as Record<string, unknown>)
      const themedSpec = injectTheme(typed as any, theme, width, layoutHeight)
      void Promise.all([import('vega-embed'), import('vega-interpreter')]).then(([{ default: embed }, { expressionInterpreter }]) => {
        if (disposed || myGen !== gen) return
        return embed(container, themedSpec as VisualizationSpec, {
          ...VEGA_EMBED_OPTIONS,
          expr: expressionInterpreter as never,
        })
      })
        .then((res) => {
          if (!res) return
          if (disposed || myGen !== gen) { res.finalize(); return }
          current?.finalize()
          current = res
          const svg = container.querySelector('svg')
          const painted = svg ? Math.ceil(svg.getBoundingClientRect().height) : 0
          setMeasuredHeight(painted > 0 ? painted : 0)
          setRenderError(false)
          setReady(true)
        })
        .catch(() => {
          if (disposed || myGen !== gen) return
          setReady(false)
          setRenderError(true)
        })
    }

    render()

    const ro = new ResizeObserver(() => {
      const width = Math.round(container.clientWidth)
      if (width > 0 && Math.abs(width - lastWidth) > 1) {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(render)
      }
    })
    ro.observe(container)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      current?.finalize()
    }
  }, [spec, theme, mapSpec, layoutHeight])

  const handleExport = async (format: ChartExportFormat) => {
    const container = containerRef.current
    if (!container || exporting) return
    setExportError('')
    setExporting(format)
    try {
      await exportChart({ spec, theme, sourceContainer: container, height: layoutHeight, format })
      menuRef.current?.removeAttribute('open')
    } catch {
      setExportError(`Could not export ${format.toUpperCase()}`)
    } finally {
      setExporting(null)
    }
  }

  // A turn recovered from sessionStorage has its spec stripped (see chatStore's
  // stripArtifactPayloads) - the "Refresh this thread" action on the interrupted turn is what
  // brings the real chart back.
  if (!spec) {
    return (
      <div className="chart-artifact artifact-placeholder">
        Chart not restored — refresh this thread to reload it.
      </div>
    )
  }

  // A MapSpec (or Vega wrapper carrying snowflakeMapSpec) must never reach vega-embed.
  if (mapSpec) return <MapArtifact spec={mapSpec} />

  return (
    <div className={`chart-artifact${scrollable ? ' chart-artifact--scroll' : ''}`}>
      {renderError && <div className="artifact-placeholder" role="status">Could not render chart</div>}
      {!ready && !renderError && <div className="artifact-placeholder">Loading chart…</div>}
      {ready && (
        <details
          ref={menuRef}
          className="chart-export"
          onClick={(event) => event.stopPropagation()}
        >
          <summary aria-label="Download visualization" title="Download visualization">•••</summary>
          <div className="chart-export-menu">
            <button type="button" disabled={exporting != null} onClick={() => void handleExport('svg')}>
              {exporting === 'svg' ? 'Saving SVG…' : 'Save as SVG'}
            </button>
            <button type="button" disabled={exporting != null} onClick={() => void handleExport('png')}>
              {exporting === 'png' ? 'Saving PNG…' : 'Save as PNG'}
            </button>
          </div>
        </details>
      )}
      {exportError && <div className="chart-export-error" role="status">{exportError}</div>}
      <div
        ref={containerRef}
        className="chart-artifact-inner"
        style={scrollable ? { height: frameHeight } : undefined}
      />
    </div>
  )
}
