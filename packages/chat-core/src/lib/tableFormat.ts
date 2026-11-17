// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { ColumnDef } from '../types.js'

export type ColumnKind = 'number' | 'boolean' | 'date' | 'timestamp' | 'text'

const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 })
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const MS_PER_DAY = 86_400_000
const EPOCH_DAYS_RE = /^-?\d+$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const EPOCH_SECONDS_RE = /^(-?\d+(?:\.\d+)?)(?:\s+-?\d+)?$/

export function columnKind(col: ColumnDef | string | undefined): ColumnKind {
  const t = (typeof col === 'string' ? col : col?.type ?? '').toLowerCase()
  if (/fixed|real|number|float|int|decimal|double/.test(t)) return 'number'
  if (t === 'boolean' || t === 'bool') return 'boolean'
  if (t === 'date') return 'date'
  if (/timestamp/.test(t)) return 'timestamp'
  return 'text'
}

export function isNumericColumn(col: ColumnDef | undefined): boolean {
  return columnKind(col) === 'number'
}

function asDateFromDateCell(value: unknown): Date | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value !== 'string' || value.trim() === '') return undefined
  if (EPOCH_DAYS_RE.test(value)) {
    const days = parseInt(value, 10)
    if (!Number.isFinite(days)) return undefined
    const utc = new Date(days * MS_PER_DAY)
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate())
  }
  if (ISO_DATE_RE.test(value)) {
    const [y, m, d] = value.split('-')
    return new Date(Number(y), Number(m) - 1, Number(d))
  }
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms) : undefined
}

function asDateFromTimestampCell(value: unknown): Date | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Cortex may send seconds or milliseconds; treat small magnitudes as seconds.
    return new Date(Math.abs(value) < 1e12 ? value * 1000 : value)
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const epoch = value.match(EPOCH_SECONDS_RE)
  if (epoch) {
    const seconds = parseFloat(epoch[1])
    return Number.isFinite(seconds) ? new Date(seconds * 1000) : undefined
  }
  const ms = Date.parse(value.replace(' ', 'T'))
  return Number.isFinite(ms) ? new Date(ms) : undefined
}

/** Display string for a table cell. Raw values stay untouched for CSV/TSV/sort. */
export function formatCell(value: unknown, col: ColumnDef | undefined): string {
  if (value == null) return ''
  const kind = columnKind(col)
  if (kind === 'boolean') {
    if (value === true || (typeof value === 'string' && value.toLowerCase() === 'true')) return 'true'
    if (value === false || (typeof value === 'string' && value.toLowerCase() === 'false')) return 'false'
    return String(value)
  }
  if (kind === 'number') {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? numberFmt.format(n) : String(value)
  }
  if (kind === 'date') {
    const d = asDateFromDateCell(value)
    return d ? dateFmt.format(d) : String(value)
  }
  if (kind === 'timestamp') {
    const d = asDateFromTimestampCell(value)
    return d ? dateTimeFmt.format(d) : String(value)
  }
  return String(value)
}

export function cellMatchesFilter(value: unknown, col: ColumnDef | undefined, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const formatted = formatCell(value, col).toLowerCase()
  if (formatted.includes(q)) return true
  const raw = String(value ?? '').toLowerCase()
  return raw.includes(q)
}
