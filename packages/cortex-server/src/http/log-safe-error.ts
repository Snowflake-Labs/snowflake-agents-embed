// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
/** Log an Error without dumping jose claims or other enumerable fields. */
export function logSafeError(label: string, err: unknown): void {
  const e = err as { name?: unknown; code?: unknown; status?: unknown; message?: unknown }
  console.error(label, {
    name: typeof e?.name === 'string' ? e.name : undefined,
    code: typeof e?.code === 'string' || typeof e?.code === 'number' ? e.code : undefined,
    status: typeof e?.status === 'number' ? e.status : undefined,
    message: typeof e?.message === 'string' ? e.message : String(err),
  })
}
