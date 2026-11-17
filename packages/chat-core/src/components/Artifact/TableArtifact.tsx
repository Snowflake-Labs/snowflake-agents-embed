// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState, useRef, useMemo, useCallback, useEffect, memo, type CSSProperties } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { ColumnDef } from '../../types.js'
import { formatCell, cellMatchesFilter, isNumericColumn } from '../../lib/tableFormat.js'

const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r'])
const COL_CHAR_PX = 10
const COL_MIN_PX = 80
const ROW_PX = 36
const HEADER_PX = 60
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function escapeSpreadsheetCell(v: unknown): string {
  const s = String(v ?? '')
  return s.length && FORMULA_LEADERS.has(s[0]) ? `'${s}` : s
}

export function escapeCsv(v: unknown): string {
  const s = escapeSpreadsheetCell(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function sanitizeCsvFilename(title?: string): string {
  const cleaned = (title ?? 'table')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || 'table'
}

interface Props {
  rowType: ColumnDef[]
  data: unknown[][]
  numRows?: number
  title?: string
}

function TableArtifactImpl({ rowType, data, numRows, title }: Props) {
  const [sortColIdx, setSortColIdx] = useState<number | null>(null)
  const [sortAsc, setSortAsc] = useState(true)
  const [filters, setFilters] = useState<string[]>(() => rowType.map(() => ''))
  const parentRef = useRef<HTMLDivElement>(null)

  const filteredIdx = useMemo(() => {
    const active = filters.some((f) => f.trim())
    if (!active) return data.map((_, i) => i)
    return data.flatMap((_, i) => {
      const row = data[i] as unknown[]
      const keep = rowType.every((col, c) => cellMatchesFilter(row[c], col, filters[c] ?? ''))
      return keep ? [i] : []
    })
  }, [data, filters, rowType])

  const sortedIdx = useMemo(() => {
    if (sortColIdx === null) return filteredIdx
    const numeric = isNumericColumn(rowType[sortColIdx])
    const idx = [...filteredIdx]
    idx.sort((ia, ib) => {
      const av = (data[ia] as unknown[])[sortColIdx]
      const bv = (data[ib] as unknown[])[sortColIdx]
      const cmp = numeric
        ? (Number(av) || 0) - (Number(bv) || 0)
        : collator.compare(String(av ?? ''), String(bv ?? ''))
      return sortAsc ? cmp : -cmp
    })
    return idx
  }, [data, filteredIdx, sortColIdx, sortAsc, rowType])

  const rowAt = (i: number) => data[sortedIdx[i]] as unknown[]
  const visibleCount = sortedIdx.length

  // Real container width, kept separate from observeElementRect below - that helper floors
  // to a synthetic 800px for zero-sized/hidden elements so virtualized cells stay mounted,
  // which would wrongly stretch columns to fill 800px whenever the panel is hidden.
  const [containerWidth, setContainerWidth] = useState(0)
  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const measure = () => setContainerWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Header-length-based widths leave the table narrower than the panel when columns have
  // short names, showing as blank space to the right. Distribute the surplus evenly across
  // columns instead - never shrinking below the header-length minimum, so a table that
  // legitimately needs more width than the panel keeps scrolling horizontally as before.
  const colWidths = useMemo(() => {
    const base = rowType.map((col) => Math.max(COL_MIN_PX, col.name.length * COL_CHAR_PX))
    if (base.length === 0) return base
    const baseTotal = base.reduce((s, w) => s + w, 0)
    if (containerWidth <= baseTotal) return base
    const extra = (containerWidth - baseTotal) / base.length
    return base.map((w) => w + extra)
  }, [rowType, containerWidth])
  const colStyles = useMemo(
    () => colWidths.map((w): CSSProperties => ({
      position: 'absolute',
      top: 0,
      left: 0,
      width: w,
      height: '100%',
    })),
    [colWidths],
  )
  const totalWidth = useMemo(() => colWidths.reduce((s, w) => s + w, 0), [colWidths])

  // happy-dom / a `hidden` ChatContainer report 0×0. Flooring keeps a window of
  // cells mounted so sort/copy still work and showing the panel remasures.
  const observeElementRect = useCallback((
    instance: Virtualizer<HTMLDivElement, Element>,
    cb: (rect: { width: number; height: number }) => void,
  ) => {
    const el = instance.scrollElement
    const notify = () => {
      const r = el?.getBoundingClientRect()
      cb({
        width: r && r.width > 0 ? r.width : 800,
        height: r && r.height > 0 ? r.height : 400,
      })
    }
    notify()
    if (!el || typeof ResizeObserver === 'undefined') return () => {}
    const ro = new ResizeObserver(notify)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rowVirtualizer = useVirtualizer({
    count: visibleCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_PX,
    overscan: 10,
    initialRect: { width: 800, height: 400 },
    observeElementRect,
  })

  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: rowType.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => colWidths[i] ?? COL_MIN_PX,
    overscan: 4,
    initialRect: { width: 800, height: 400 },
    observeElementRect,
  })

  // colVirtualizer caches each column's measured size on first read and reuses it even
  // after estimateSize's own inputs change, so when the fill pass grows colWidths post-mount
  // the cells resize but their translateX offsets stay pinned to the original cramped
  // spacing, overlapping. measure() clears that cache so offsets recompute from the new sizes.
  useEffect(() => {
    colVirtualizer.measure()
  }, [colWidths, colVirtualizer])

  function handleSort(idx: number) {
    if (sortColIdx === idx) setSortAsc((a) => !a)
    else { setSortColIdx(idx); setSortAsc(true) }
  }

  const isStub = rowType.length === 0 && numRows !== undefined && numRows > 0

  function copyAll() {
    const header = rowType.map((c) => escapeSpreadsheetCell(c.name)).join('\t')
    const body = Array.from({ length: data.length }, (_, i) =>
      rowType.map((_, c) => escapeSpreadsheetCell(rowAt(i)[c])).join('\t'),
    ).join('\n')
    void navigator.clipboard.writeText(`${header}\n${body}`)
  }

  function downloadCsv() {
    const header = rowType.map((c) => escapeCsv(c.name)).join(',')
    const body = Array.from({ length: data.length }, (_, i) =>
      rowType.map((_, c) => escapeCsv(rowAt(i)[c])).join(','),
    ).join('\n')
    const blob = new Blob([`${header}\n${body}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitizeCsvFilename(title)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (isStub) {
    return (
      <div className="table-artifact artifact-placeholder">
        {numRows} rows not restored — refresh this thread to reload them.
      </div>
    )
  }

  const virtualCols = colVirtualizer.getVirtualItems()
  const rowTotal = rowVirtualizer.getTotalSize()

  return (
    <div className="table-artifact">
      <div className="table-toolbar">
        <div className="table-toolbar-actions">
          <button onClick={(e) => { e.stopPropagation(); copyAll() }}>Copy all as TSV</button>
          <button onClick={(e) => { e.stopPropagation(); downloadCsv() }}>Download CSV</button>
        </div>
        <div className="table-toolbar-info">
          {numRows !== undefined && numRows > data.length && (
            <span className="truncation-banner">Showing {data.length} of {numRows} rows</span>
          )}
          <span className="row-count">
            {visibleCount === data.length ? `${data.length} rows` : `${visibleCount} of ${data.length} rows`}
          </span>
        </div>
      </div>
      <div
        ref={parentRef}
        className="table-body"
        style={{ height: Math.min(400, HEADER_PX + rowTotal), overflow: 'auto' }}
      >
        <div style={{ width: totalWidth, height: HEADER_PX + rowTotal }}>
          <div className="table-header" style={{ width: totalWidth, height: HEADER_PX }}>
            {virtualCols.map((col) => {
              const def = rowType[col.index]
              return (
                <div
                  key={col.index}
                  className={`th${isNumericColumn(def) ? ' th--num' : ''}`}
                  style={{ ...colStyles[col.index], transform: `translateX(${col.start}px)` }}
                >
                  <button type="button" className="th-label" onClick={() => handleSort(col.index)}>
                    {def.name}
                    {sortColIdx === col.index ? (sortAsc ? ' ▲' : ' ▼') : ''}
                  </button>
                  <input
                    className="th-filter"
                    type="search"
                    placeholder="Filter"
                    aria-label={`Filter ${def.name}`}
                    value={filters[col.index] ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const next = e.target.value
                      setFilters((prev) => {
                        const copy = prev.length === rowType.length ? [...prev] : rowType.map(() => '')
                        copy[col.index] = next
                        return copy
                      })
                    }}
                  />
                </div>
              )
            })}
          </div>
          <div style={{ height: rowTotal, width: totalWidth, position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                className="tr"
                style={{ transform: `translateY(${item.start}px)`, width: totalWidth, height: ROW_PX }}
              >
                {virtualCols.map((col) => {
                  const def = rowType[col.index]
                  const raw = rowAt(item.index)[col.index]
                  const text = formatCell(raw, def)
                  return (
                    <div
                      key={col.index}
                      className={`td${isNumericColumn(def) ? ' td--num' : ''}`}
                      style={{ ...colStyles[col.index], transform: `translateX(${col.start}px)` }}
                      title={text}
                    >
                      {text}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export const TableArtifact = memo(TableArtifactImpl)
