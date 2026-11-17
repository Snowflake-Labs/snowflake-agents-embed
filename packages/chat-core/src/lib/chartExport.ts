// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { VisualizationSpec } from 'vega-embed'
import { applyColumnTypesToSpec } from './formatVegaData.js'
import { VEGA_EMBED_OPTIONS } from './sanitizeChartSpec.js'
import { injectTheme } from './vega-theme.js'

export type ChartExportFormat = 'png' | 'svg'

const MESSAGE_LIST_HORIZONTAL_PADDING = 32
const ASSISTANT_TURN_WIDTH_RATIO = 0.85
const CHART_HORIZONTAL_PADDING = 32

/**
 * Resolve the chart width before the right artifact panel takes space from the chat.
 * This mirrors the full-width chat layout: message-list padding, the assistant turn's
 * 85% max-width, and the chart artifact's own horizontal padding.
 */
export function resolveChartExportWidth(sourceContainer: HTMLElement): number {
  const shell = sourceContainer.closest('.app-shell')
  if (!(shell instanceof HTMLElement) || shell.clientWidth <= 0) {
    return Math.max(1, Math.round(sourceContainer.clientWidth))
  }

  const sidebar = Array.from(shell.children).find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('sidebar'),
  )
  const mainWidth = shell.clientWidth - (sidebar?.clientWidth ?? 0)
  const messageWidth = Math.max(0, mainWidth - MESSAGE_LIST_HORIZONTAL_PADDING)
  const fullChartWidth = Math.round(
    messageWidth * ASSISTANT_TURN_WIDTH_RATIO - CHART_HORIZONTAL_PADDING,
  )

  return Math.max(1, Math.round(sourceContainer.clientWidth), fullChartWidth)
}

interface ExportChartOptions {
  spec: VisualizationSpec
  theme: string
  sourceContainer: HTMLElement
  height: number
  format: ChartExportFormat
  filename?: string
}

export async function exportChart({
  spec,
  theme,
  sourceContainer,
  height,
  format,
  filename = 'visualization',
}: ExportChartOptions): Promise<void> {
  const width = resolveChartExportWidth(sourceContainer)
  const typed = applyColumnTypesToSpec(spec as Record<string, unknown>)
  const themedSpec = injectTheme(typed as any, theme, width, height)
  const mount = document.createElement('div')
  mount.setAttribute('aria-hidden', 'true')
  Object.assign(mount.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
    pointerEvents: 'none',
    visibility: 'hidden',
  })
  document.body.appendChild(mount)

  let result: Awaited<ReturnType<typeof import('vega-embed')['default']>> | undefined
  try {
    const [{ default: embed }, { expressionInterpreter }] = await Promise.all([
      import('vega-embed'),
      import('vega-interpreter'),
    ])
    result = await embed(mount, themedSpec as VisualizationSpec, {
      ...VEGA_EMBED_OPTIONS,
      expr: expressionInterpreter as never,
    })
    const url = await result.view.toImageURL(format)
    const link = document.createElement('a')
    link.href = url
    link.download = `${filename}.${format}`
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    result?.finalize()
    mount.remove()
  }
}
