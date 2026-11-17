// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Date/user used to be prepended onto the query text. That poisoned verified-query
// matching: native SI takes an exact-match VQR shortcut when the user message is the
// question alone, and our prefix turned "exactly matches" into "looks like" plus an
// extra Analyst + chart planning path (~28s). Native sends this as experimental
// metadata instead (EnableClientSideDateFormatting / UserTimezone / systemPromptInternal).

export function buildClientDateContext(currentUserName?: string): Record<string, unknown> {
  return {
    EnableClientSideDateFormatting: true,
    EnableAnswerBeforeProactiveChartGeneration: true,
    UserTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(currentUserName
      ? {
          systemPromptInternal: {
            prompt: 'The current date and time is {{.date}}, my username is {{.username}}, my full name is {{.fullName}}, my email is {{.email}}',
            attributes: {
              date: new Date().toISOString(),
              fullName: currentUserName,
              email: '',
              username: currentUserName,
            },
          },
        }
      : {}),
  }
}
