// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react'
import * as microsoftTeams from '@microsoft/teams-js'

export function useTeamsTheme(): string {
  const [theme, setTheme] = useState('default')

  useEffect(() => {
    microsoftTeams.app.getContext().then((ctx) => {
      setTheme(ctx.app.theme ?? 'default')
    }).catch(() => {})

    microsoftTeams.registerOnThemeChangeHandler((t) => {
      setTheme(t)
      document.documentElement.setAttribute('data-teams-theme', t)
    })
  }, [])

  return theme
}
