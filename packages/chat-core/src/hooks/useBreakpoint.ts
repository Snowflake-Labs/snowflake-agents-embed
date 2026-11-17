// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState, useEffect, useRef } from 'react'

export type Breakpoint = 'wide' | 'mid' | 'narrow'

function classify(w: number): Breakpoint {
  if (w >= 1100) return 'wide'
  if (w >= 700) return 'mid'
  return 'narrow'
}

export function useBreakpoint(): { bp: Breakpoint; ref: React.RefObject<HTMLDivElement | null> } {
  const ref = useRef<HTMLDivElement>(null)
  const [bp, setBp] = useState<Breakpoint>('mid')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    setBp(classify(el.offsetWidth))
    if (typeof ResizeObserver === 'undefined') return
    const obs = new ResizeObserver(([entry]) => {
      setBp(classify(entry.contentRect.width))
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  return { bp, ref }
}
