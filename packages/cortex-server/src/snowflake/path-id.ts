// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const THREAD_ID_RE = /^\d{1,32}$/
const PARTITION_RE = /^\d{1,10}$/

const UNQUOTED_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/

/** Unquoted Snowflake identifier: the only shape allowed into a REST path or SQL name. */
export function assertIdentifier(value: string, label = 'identifier'): string {
  if (!UNQUOTED_IDENT.test(value)) throw new InvalidPathIdError(`Invalid ${label}`)
  return value
}

export class InvalidPathIdError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPathIdError'
  }
}

function assertPathname(url: URL, prefix: string): void {
  if (!url.pathname.startsWith(prefix)) {
    throw new InvalidPathIdError(`Resolved path escaped ${prefix}`)
  }
}

/** Statement handles are UUIDs. Reject anything else before building a Snowflake REST URL. */
export function statementUrl(accountBase: string, handle: string, partition?: string | null): URL {
  if (!UUID_RE.test(handle)) throw new InvalidPathIdError('Invalid statement handle')
  if (partition != null && partition !== '' && !PARTITION_RE.test(partition)) {
    throw new InvalidPathIdError('Invalid partition')
  }
  const url = new URL(`${accountBase}/api/v2/statements/${encodeURIComponent(handle)}`)
  assertPathname(url, '/api/v2/statements/')
  if (partition) url.searchParams.set('partition', partition)
  return url
}

/** Cortex thread ids in this product are decimal integers. */
export function threadUrl(threadsBase: string, id: string): URL {
  if (!THREAD_ID_RE.test(id)) throw new InvalidPathIdError('Invalid thread id')
  const url = new URL(`${threadsBase}/${encodeURIComponent(id)}`)
  assertPathname(url, '/api/v2/cortex/threads/')
  return url
}
