// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react'

// Warns the user before they navigate away or close the tab mid-stream, since the answer is
// lost client-side (the run itself keeps going server-side - see StopButton's tooltip). Manual
// verification is required inside the Teams iframe: jsdom/happy-dom register the listener but
// can't exercise the browser's actual unload-confirmation UI.
export function useBeforeUnloadWarning(active: boolean) {
  useEffect(() => {
    if (!active) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [active])
}
