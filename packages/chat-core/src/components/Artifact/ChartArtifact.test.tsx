// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChartArtifact } from './ChartArtifact'

const embedMock = vi.fn().mockResolvedValue({ finalize: vi.fn() })
const exportChartMock = vi.fn().mockResolvedValue(undefined)
vi.mock('vega-embed', () => ({ default: (...args: unknown[]) => embedMock(...args) }))
vi.mock('../../lib/chartExport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/chartExport')>()
  return { ...actual, exportChart: (...args: unknown[]) => exportChartMock(...args) }
})

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  // jsdom reports clientWidth as 0; ChartArtifact bails on a non-positive width, so embed()
  // would never fire without this.
  Object.defineProperty(HTMLDivElement.prototype, 'clientWidth', { configurable: true, value: 400 })
  Object.defineProperty(HTMLDivElement.prototype, 'clientHeight', { configurable: true, value: 320 })
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('720'),
    addEventListener() {},
    removeEventListener() {},
  }))
  embedMock.mockReset().mockResolvedValue({ finalize: vi.fn() })
  exportChartMock.mockReset().mockResolvedValue(undefined)
})

afterEach(() => { vi.restoreAllMocks() })

describe('ChartArtifact', () => {
  it('uses the custom export menu instead of container-bound Vega actions', async () => {
    render(<ChartArtifact spec={{ mark: 'bar' } as any} />)
    await waitFor(() => {
      expect(embedMock).toHaveBeenCalled()
    })
    expect(embedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        actions: false,
        renderer: 'svg',
        mode: 'vega-lite',
        ast: true,
        loader: expect.objectContaining({ load: expect.any(Function), sanitize: expect.any(Function) }),
      }),
    )
    fireEvent.click(screen.getByLabelText('Download visualization'))
    expect(screen.getByRole('button', { name: 'Save as SVG' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save as PNG' })).toBeTruthy()
  })

  it('grows the frame to the painted SVG so legend + axes are never clipped', async () => {
    embedMock.mockImplementation(async (container: HTMLElement) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.getBoundingClientRect = () => ({ height: 470 }) as DOMRect
      container.appendChild(svg)
      return { finalize: vi.fn() }
    })
    render(<ChartArtifact spec={{ mark: 'point' } as any} />)
    await waitFor(() => {
      expect((document.querySelector('.chart-artifact-inner') as HTMLElement).style.height).toBe('470px')
    })
    expect(document.querySelector('.chart-artifact--scroll')).toBeTruthy()
    expect(embedMock).toHaveBeenCalledTimes(1)
  })

  it('sizes a 20-row horizontal bar to a fixed 580px, not the inner clientHeight', async () => {
    const values = Array.from({ length: 20 }, (_, i) => ({ product: `P${i}`, sales: i }))
    render(<ChartArtifact spec={{
      mark: 'bar',
      encoding: {
        y: { field: 'product', type: 'nominal' },
        x: { field: 'sales', type: 'quantitative' },
      },
      data: { values },
    } as any} />)
    await waitFor(() => expect(embedMock).toHaveBeenCalled())
    const themed = embedMock.mock.calls[0][1] as { height: number; autosize: { type: string } }
    expect(themed.height).toBe(580)
    expect(themed.autosize.type).toBe('fit-x')
    expect(document.querySelector('.chart-artifact--scroll')).toBeTruthy()
    expect((document.querySelector('.chart-artifact-inner') as HTMLElement).style.height).toBe('580px')
  })

  it('exports the full horizontal-bar height as PNG', async () => {
    const values = Array.from({ length: 20 }, (_, i) => ({ product: `P${i}`, sales: i }))
    const spec = {
      mark: 'bar',
      encoding: {
        y: { field: 'product', type: 'nominal' },
        x: { field: 'sales', type: 'quantitative' },
      },
      data: { values },
    } as any
    render(<ChartArtifact spec={spec} />)
    await waitFor(() => expect(screen.getByLabelText('Download visualization')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Download visualization'))
    fireEvent.click(screen.getByRole('button', { name: 'Save as PNG' }))
    await waitFor(() => expect(exportChartMock).toHaveBeenCalled())
    expect(exportChartMock).toHaveBeenCalledWith(expect.objectContaining({
      spec,
      height: 580,
      format: 'png',
      sourceContainer: document.querySelector('.chart-artifact-inner'),
    }))
  })

  it('shows an error instead of spinning when embed fails', async () => {
    embedMock.mockRejectedValue(new Error('EvalError: call to Function() blocked by CSP'))
    render(<ChartArtifact spec={{ mark: 'bar' } as any} />)
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Could not render chart')
    })
    expect(screen.queryByText('Loading chart…')).toBeNull()
  })

  it('does not hand a MapSpec to vega-embed', async () => {
    render(<ChartArtifact spec={{
      version: 1,
      layer: { type: 'latlon', encoding: { latColumn: 'lat', lonColumn: 'lon' } },
      data: { values: [] },
    } as any} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(embedMock).not.toHaveBeenCalled()
    expect(document.querySelector('.map-artifact')).toBeTruthy()
  })
})
