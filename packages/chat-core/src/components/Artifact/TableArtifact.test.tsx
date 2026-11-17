// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TableArtifact, escapeCsv, escapeSpreadsheetCell, sanitizeCsvFilename } from './TableArtifact'

const rowType = [{ name: 'REGION', type: 'text' }, { name: 'SALES', type: 'NUMBER' }]
const data: unknown[][] = [['Central', 100], ['East', 200]]

afterEach(() => { vi.restoreAllMocks() })

describe('TableArtifact', () => {
  it('sizes columns in pixels from header length instead of a uniform flex:1', () => {
    const cols = [{ name: 'ID', type: 'text' }, { name: 'DEPARTMENT_NAME', type: 'text' }]
    render(<TableArtifact rowType={cols} data={[['1', 'Sales']]} />)
    const headers = document.querySelectorAll('.th')
    expect((headers[0] as HTMLElement).style.width).toBe('80px')
    expect((headers[1] as HTMLElement).style.width).toBe('150px')
  })

  it('fills available container width across columns when it exceeds the natural table width', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500)
    const cols = [{ name: 'ID', type: 'text' }, { name: 'REGION', type: 'text' }]
    render(<TableArtifact rowType={cols} data={[['1', 'East']]} />)
    const headers = document.querySelectorAll('.th')
    // base: 80 ('ID'), 80 ('REGION' floored from 60) -> baseTotal 160; extra (500-160)/2 = 170
    expect((headers[0] as HTMLElement).style.width).toBe('250px')
    expect((headers[1] as HTMLElement).style.width).toBe('250px')
  })

  it('keys header and body cells by column index so duplicate names still render', () => {
    const cols = [{ name: 'ID', type: 'text' }, { name: 'ID', type: 'text' }]
    render(<TableArtifact rowType={cols} data={[['a', 'b']]} />)
    const headers = document.querySelectorAll('.th-label')
    expect(headers).toHaveLength(2)
    expect(headers[0].textContent).toBe('ID')
    expect(headers[1].textContent).toBe('ID')
    const cells = document.querySelectorAll('.td')
    expect([...cells].map((c) => c.textContent)).toEqual(['a', 'b'])
  })

  it('sorts numeric columns by number and text columns by locale', () => {
    const cols = [{ name: 'N', type: 'NUMBER' }, { name: 'L', type: 'text' }]
    const rows: unknown[][] = [['10', 'b'], ['2', 'a'], ['3', 'c']]
    render(<TableArtifact rowType={cols} data={rows} />)
    fireEvent.click(document.querySelectorAll('.th-label')[0])
    expect([...document.querySelectorAll('.td')].filter((_, i) => i % 2 === 0).map((c) => c.textContent))
      .toEqual(['2', '3', '10'])
    fireEvent.click(document.querySelectorAll('.th-label')[1])
    expect([...document.querySelectorAll('.td')].filter((_, i) => i % 2 === 1).map((c) => c.textContent))
      .toEqual(['a', 'b', 'c'])
  })

  it('copies all rows as TSV', () => {
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<TableArtifact rowType={rowType} data={data} />)
    fireEvent.click(screen.getByText('Copy all as TSV'))
    expect(writeText).toHaveBeenCalledWith('REGION\tSALES\nCentral\t100\nEast\t200')
  })

  it('downloads a CSV with escaped values via a Blob', async () => {
    const created = vi.fn((_: Blob) => 'blob:mock')
    const revoked = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: created, revokeObjectURL: revoked })
    const clickSpy = vi.fn()
    const origCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag)
      if (tag === 'a') el.click = clickSpy
      return el
    })

    render(<TableArtifact rowType={rowType} data={[['Central, TX', 100]]} title="My Table" />)
    fireEvent.click(screen.getByText('Download CSV'))

    expect(created).toHaveBeenCalledOnce()
    const blob = created.mock.calls[0][0] as Blob
    expect(await blob.text()).toBe('REGION,SALES\n"Central, TX",100')
    expect(clickSpy).toHaveBeenCalledOnce()
    expect(revoked).toHaveBeenCalledWith('blob:mock')
  })

  it('prefixes formula-leading cells and sanitizes the download filename', () => {
    expect(escapeSpreadsheetCell('=HYPERLINK("https://evil")')).toBe('\'=HYPERLINK("https://evil")')
    expect(escapeCsv('=1+1')).toBe("'=1+1")
    expect(sanitizeCsvFilename('Q3; DROP TABLE.xlsx')).toBe('Q3 DROP TABLExlsx')
    expect(sanitizeCsvFilename('!!!')).toBe('table')
  })

  it('shows a truncation banner only when numRows exceeds the rendered rows', () => {
    render(<TableArtifact rowType={rowType} data={data} numRows={50} />)
    expect(screen.getByText('Showing 2 of 50 rows')).toBeTruthy()
  })

  it('shows no truncation banner when numRows equals the rendered rows', () => {
    render(<TableArtifact rowType={rowType} data={data} numRows={2} />)
    expect(screen.queryByText(/Showing/)).toBeNull()
  })

  it('shows no truncation banner when numRows is not provided', () => {
    render(<TableArtifact rowType={rowType} data={data} />)
    expect(screen.queryByText(/Showing/)).toBeNull()
  })

  it('does not bubble toolbar button clicks to a wrapping onClick handler', () => {
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const onWrapperClick = vi.fn()
    render(
      <div onClick={onWrapperClick}>
        <TableArtifact rowType={rowType} data={data} />
      </div>,
    )
    fireEvent.click(screen.getByText('Copy all as TSV'))
    fireEvent.click(screen.getByText('Download CSV'))
    expect(onWrapperClick).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalled()
  })

  it('filters rows by a per-column query before sort', () => {
    render(<TableArtifact rowType={rowType} data={data} />)
    fireEvent.change(screen.getByLabelText('Filter REGION'), { target: { value: 'east' } })
    expect([...document.querySelectorAll('.td')].map((c) => c.textContent)).toEqual(['East', '200'])
    expect(screen.getByText('1 of 2 rows')).toBeTruthy()
  })

  it('puts the raw cell value on title so a truncated cell is still readable', () => {
    render(<TableArtifact rowType={rowType} data={[['Central', 100]]} />)
    const cells = document.querySelectorAll('.td')
    expect((cells[0] as HTMLElement).title).toBe('Central')
    expect((cells[1] as HTMLElement).className).toContain('td--num')
  })
})
