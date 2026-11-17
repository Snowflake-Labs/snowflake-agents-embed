// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react'

interface Props {
  open: boolean
  side: 'left' | 'right'
  onClose: () => void
  children: React.ReactNode
}

export function Drawer({ open, side, onClose, children }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    // Focus lands on the drawer itself on open (not the first focusable child - the drawer
    // has no natural "first field" the way a form does), so Escape/Tab below have something
    // to originate from immediately.
    rootRef.current?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !rootRef.current) return
      const focusable = rootRef.current.querySelectorAll<HTMLElement>(
        'a[href], button, textarea, input, select, [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      // Wrap Tab at the edges so focus never escapes to the (still-visible, but backdrop-
      // covered) content behind the drawer.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className={`drawer drawer--${side}`} ref={rootRef} tabIndex={-1} role="dialog" aria-modal="true">
        {children}
      </div>
    </>
  )
}
