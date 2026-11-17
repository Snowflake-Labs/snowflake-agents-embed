// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Slim port of Intelligence `formatVegaDataWithColumnTypes` / `coerceVegaValue`.
 * Cortex streams every SQL cell as a string; Vega-Lite needs real numbers,
 * booleans, and epoch-ms for temporal encodings.
 */

export interface VegaColumnType {
  name: string
  type: string
}

type VegaValue = unknown
export type VegaData = Record<string, VegaValue>[]

const NUMERIC_SNOWFLAKE_TYPES = new Set(['fixed', 'real'])
const TIMESTAMP_SNOWFLAKE_TYPES = new Set(['timestamp_ntz', 'timestamp_ltz', 'timestamp_tz'])
const MS_PER_DAY = 86_400_000
const EPOCH_DAYS_RE = /^-?\d+$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const EPOCH_SECONDS_RE = /^(-?\d+(?:\.\d+)?)(?:\s+-?\d+)?$/

function coerceToNumber(value: VegaValue): VegaValue {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return value
  if (value.trim() === '') return value
  const n = Number(value)
  return Number.isFinite(n) ? n : value
}

function coerceToBoolean(value: VegaValue): VegaValue {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return value
  const lower = value.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  return value
}

function localMidnightMs(year: number, monthIndex: number, day: number): number {
  return new Date(year, monthIndex, day).getTime()
}

function coerceDateToEpochMs(value: VegaValue): VegaValue {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return value

  if (EPOCH_DAYS_RE.test(value)) {
    const days = parseInt(value, 10)
    if (!Number.isFinite(days)) return value
    const utc = new Date(days * MS_PER_DAY)
    return localMidnightMs(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate())
  }

  if (ISO_DATE_RE.test(value)) {
    const [y, m, d] = value.split('-')
    const ms = localMidnightMs(Number(y), Number(m) - 1, Number(d))
    return Number.isFinite(ms) ? ms : value
  }

  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : value
}

function coerceTimestampToEpochMs(value: VegaValue): VegaValue {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return value

  const epochMatch = value.match(EPOCH_SECONDS_RE)
  if (epochMatch) {
    const seconds = parseFloat(epochMatch[1])
    return Number.isFinite(seconds) ? seconds * 1000 : value
  }

  const direct = Date.parse(value)
  if (Number.isFinite(direct)) return direct

  const isoLike = value.replace(' ', 'T').replace(/\s+(?=[+-]\d{2}:?\d{2}$)/, '')
  const lenient = Date.parse(isoLike)
  if (Number.isFinite(lenient)) return lenient

  const asUtc = Date.parse(isoLike + 'Z')
  return Number.isFinite(asUtc) ? asUtc : value
}

function coerceVegaValue(value: VegaValue, snowflakeType: string): VegaValue {
  if (value === null || value === undefined) return value
  const t = snowflakeType.toLowerCase()
  if (NUMERIC_SNOWFLAKE_TYPES.has(t)) return coerceToNumber(value)
  if (t === 'boolean') return coerceToBoolean(value)
  if (t === 'date') return coerceDateToEpochMs(value)
  if (TIMESTAMP_SNOWFLAKE_TYPES.has(t)) return coerceTimestampToEpochMs(value)
  return value
}

export function parseColumnTypes(value: unknown): VegaColumnType[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: VegaColumnType[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.name !== 'string' || typeof e.type !== 'string') continue
    out.push({ name: e.name, type: e.type })
  }
  return out.length > 0 ? out : undefined
}

export function getSnowflakeColumnTypes(spec: unknown): VegaColumnType[] | undefined {
  const meta = (spec as { usermeta?: { snowflake?: { columnTypes?: unknown } } } | undefined)
    ?.usermeta?.snowflake?.columnTypes
  return parseColumnTypes(meta)
}

export function formatVegaDataWithColumnTypes(
  rows: VegaData,
  columnTypes: VegaColumnType[] | undefined,
): VegaData {
  if (!columnTypes || columnTypes.length === 0 || rows.length === 0) return rows

  const typeByName = new Map<string, string>()
  for (const col of columnTypes) typeByName.set(col.name, col.type)

  return rows.map((row) => {
    const out: Record<string, VegaValue> = {}
    for (const key of Object.keys(row)) {
      const colType = typeByName.get(key)
      out[key] = colType !== undefined ? coerceVegaValue(row[key], colType) : row[key]
    }
    return out
  })
}

/** Clone a spec and coerce top-level `data.values` when columnTypes are present. */
export function applyColumnTypesToSpec<T extends Record<string, unknown>>(spec: T): T {
  const columnTypes = getSnowflakeColumnTypes(spec)
  const data = spec.data
  if (!columnTypes || !data || typeof data !== 'object' || Array.isArray(data)) return spec
  const values = (data as { values?: unknown }).values
  if (!Array.isArray(values) || values.length === 0) return spec
  if (!values.every((row) => row && typeof row === 'object' && !Array.isArray(row))) return spec
  return {
    ...spec,
    data: { ...data, values: formatVegaDataWithColumnTypes(values as VegaData, columnTypes) },
  }
}
