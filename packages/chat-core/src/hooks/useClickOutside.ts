// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect, type RefObject } from 'react'

/**
 * `mousedown`, not `click`, so a drag that starts outside the ref'd element (e.g. a text
 * selection or a scroll-drag) doesn't leave the popover open just because the eventual
 * `click` target ends up back inside it.
 */
export function useClickOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [active, ref, onOutside])
}
