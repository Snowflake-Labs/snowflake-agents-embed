// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import React from 'react'
import ReactDOM from 'react-dom/client'

export const BOOTSTRAP_ERROR_COPY = 'Could not connect to Microsoft Teams — reload'

export function BootstrapErrorPanel() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      gap: 12,
      padding: 24,
      textAlign: 'center',
    }}>
      <p>{BOOTSTRAP_ERROR_COPY}</p>
    </div>
  )
}

export function renderBootstrapError(rootEl: HTMLElement | null = document.getElementById('root')) {
  if (!rootEl) return
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <BootstrapErrorPanel />
    </React.StrictMode>,
  )
}
