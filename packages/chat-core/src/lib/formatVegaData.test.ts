// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import {
  formatVegaDataWithColumnTypes,
  applyColumnTypesToSpec,
  type VegaColumnType,
} from './formatVegaData.js'

function cols(...pairs: [string, string][]): VegaColumnType[] {
  return pairs.map(([name, type]) => ({ name, type }))
}

describe('formatVegaDataWithColumnTypes', () => {
  it('returns the input by reference when there is nothing to coerce', () => {
    const rows = [{ A: '1' }]
    expect(formatVegaDataWithColumnTypes(rows, undefined)).toBe(rows)
    expect(formatVegaDataWithColumnTypes(rows, [])).toBe(rows)
    expect(formatVegaDataWithColumnTypes([], cols(['A', 'fixed']))).toEqual([])
  })

  it('coerces fixed/real numeric strings, leaving unparseable cells alone', () => {
    expect(formatVegaDataWithColumnTypes([{ VAL: '1234.56' }], cols(['VAL', 'fixed']))).toEqual([{ VAL: 1234.56 }])
    expect(formatVegaDataWithColumnTypes([{ VAL: '1.5e10' }], cols(['VAL', 'fixed']))).toEqual([{ VAL: 15000000000 }])
    expect(formatVegaDataWithColumnTypes([{ VAL: 'abc' }], cols(['VAL', 'fixed']))).toEqual([{ VAL: 'abc' }])
    expect(formatVegaDataWithColumnTypes([{ VAL: '' }], cols(['VAL', 'fixed']))).toEqual([{ VAL: '' }])
    expect(formatVegaDataWithColumnTypes([{ VAL: 42 }], cols(['VAL', 'fixed']))).toEqual([{ VAL: 42 }])
  })

  it('coerces boolean strings case-insensitively', () => {
    expect(formatVegaDataWithColumnTypes([{ FLAG: 'TRUE' }], cols(['FLAG', 'boolean']))).toEqual([{ FLAG: true }])
    expect(formatVegaDataWithColumnTypes([{ FLAG: 'False' }], cols(['FLAG', 'boolean']))).toEqual([{ FLAG: false }])
    expect(formatVegaDataWithColumnTypes([{ FLAG: 'yes' }], cols(['FLAG', 'boolean']))).toEqual([{ FLAG: 'yes' }])
  })

  it('coerces DATE epoch-days and YYYY-MM-DD to local-midnight epoch-ms', () => {
    const [iso] = formatVegaDataWithColumnTypes([{ D: '2023-10-11' }], cols(['D', 'date']))
    expect(iso.D).toBe(new Date(2023, 9, 11).getTime())
    const [days] = formatVegaDataWithColumnTypes([{ D: '19641' }], cols(['D', 'date']))
    const utc = new Date(19641 * 86_400_000)
    expect(days.D).toBe(new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate()).getTime())
  })

  it('coerces timestamp epoch-seconds to ms', () => {
    expect(formatVegaDataWithColumnTypes([{ TS: '1697068800' }], cols(['TS', 'timestamp_ntz']))).toEqual([
      { TS: 1697068800000 },
    ])
  })

  it('is case-insensitive on the Snowflake type name and leaves unknown types alone', () => {
    expect(formatVegaDataWithColumnTypes([{ V: '42' }], cols(['V', 'FIXED']))).toEqual([{ V: 42 }])
    expect(formatVegaDataWithColumnTypes([{ V: 'anything' }], cols(['V', 'text']))).toEqual([{ V: 'anything' }])
  })

  it('is idempotent', () => {
    const rows = [{ VAL: '12' }]
    const c = cols(['VAL', 'fixed'])
    const once = formatVegaDataWithColumnTypes(rows, c)
    expect(formatVegaDataWithColumnTypes(once, c)).toEqual(once)
  })
})

describe('applyColumnTypesToSpec', () => {
  it('coerces top-level data.values from usermeta.snowflake.columnTypes', () => {
    const spec = {
      mark: 'bar',
      data: { values: [{ REVENUE: '100' }] },
      usermeta: { snowflake: { columnTypes: [{ name: 'REVENUE', type: 'fixed' }] } },
    }
    expect(applyColumnTypesToSpec(spec).data.values).toEqual([{ REVENUE: 100 }])
  })

  it('returns the spec unchanged when columnTypes or values are missing', () => {
    const spec = { mark: 'bar', data: { values: [{ A: '1' }] } }
    expect(applyColumnTypesToSpec(spec)).toBe(spec)
  })
})
