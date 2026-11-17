// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, type ReactNode } from 'react'

const ThemeContext = createContext('default')

export function ThemeProvider({ theme, children }: { theme: string; children: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
}

export function useTheme(): string {
  return useContext(ThemeContext)
}
