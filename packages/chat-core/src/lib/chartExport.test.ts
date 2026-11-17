// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportChart, resolveChartExportWidth } from './chartExport'

const finalize = vi.fn()
const toImageURL = vi.fn()
const embedMock = vi.fn().mockResolvedValue({ finalize, view: { toImageURL } })

vi.mock('vega-embed', () => ({ default: (...args: unknown[]) => embedMock(...args) }))

function setWidth(element: HTMLElement, width: number) {
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: width })
}

function makeLayout() {
  const shell = document.createElement('div')
  shell.className = 'app-shell'
  setWidth(shell, 1000)
  const sidebar = document.createElement('aside')
  sidebar.className = 'sidebar'
  setWidth(sidebar, 100)
  const source = document.createElement('div')
  source.className = 'chart-artifact-inner'
  setWidth(source, 240)
  shell.append(sidebar, source)
  document.body.appendChild(shell)
  return { shell, source }
}

beforeEach(() => {
  embedMock.mockReset().mockResolvedValue({ finalize, view: { toImageURL } })
  finalize.mockClear()
  toImageURL.mockReset()
})

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('resolveChartExportWidth', () => {
  it('uses the full chat width instead of the narrow artifact panel', () => {
    const { source } = makeLayout()
    expect(resolveChartExportWidth(source)).toBe(706)
  })

  it('never shrinks a source chart that is already wider', () => {
    const { source } = makeLayout()
    setWidth(source, 900)
    expect(resolveChartExportWidth(source)).toBe(900)
  })
})

describe('exportChart', () => {
  it.each(['png', 'svg'] as const)('downloads a full-width %s and cleans up', async (format) => {
    const { source } = makeLayout()
    const clicked: Array<{ download: string; href: string }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href })
    })
    toImageURL.mockResolvedValue(`data:image/${format};base64,exported`)
    const values = Array.from({ length: 20 }, (_, i) => ({ product: `P${i}`, sales: i }))

    await exportChart({
      spec: {
        mark: 'bar',
        encoding: {
          y: { field: 'product', type: 'nominal' },
          x: { field: 'sales', type: 'quantitative' },
        },
        data: { values },
      } as any,
      theme: 'light',
      sourceContainer: source,
      height: 580,
      format,
    })

    expect(embedMock).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ width: 706, height: 580 }),
      expect.objectContaining({ actions: false, renderer: 'svg', mode: 'vega-lite', ast: true }),
    )
    expect(toImageURL).toHaveBeenCalledWith(format)
    expect(clicked).toEqual([{ download: `visualization.${format}`, href: `data:image/${format};base64,exported` }])
    expect(finalize).toHaveBeenCalledOnce()
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('finalizes and removes the detached view when image generation fails', async () => {
    const { source } = makeLayout()
    toImageURL.mockRejectedValue(new Error('render failed'))

    await expect(exportChart({
      spec: { mark: 'bar' } as any,
      theme: 'light',
      sourceContainer: source,
      height: 320,
      format: 'png',
    })).rejects.toThrow('render failed')

    expect(finalize).toHaveBeenCalledOnce()
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull()
  })
})
