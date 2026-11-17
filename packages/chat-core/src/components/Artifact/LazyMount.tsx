// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Reserved height so the list does not jump when the real artifact mounts. */
  minHeight?: number
}

/**
 * Mounts children only after the placeholder intersects the viewport, so off-screen
 * charts never create a Vega view. Once visible, stays mounted (re-embedding on every
 * scroll-back is worse than holding the view).
 */
export function LazyMount({ children, minHeight = 80 }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    if (visible) return
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    // Do not close over `io` inside the constructor callback: happy-dom (and our test
    // stubs) fire synchronously, which would read `io` in the TDZ.
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible(true)
    }, { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [visible])

  return (
    <div ref={ref} className="lazy-mount" style={visible ? undefined : { minHeight }}>
      {visible ? children : <div className="artifact-placeholder" />}
    </div>
  )
}
