// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
export class ApiError extends Error {
  status?: number
  code?: string
  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export async function throwFromResponse(res: Response, action: string): Promise<never> {
  let detail: string | undefined
  let code: string | undefined
  try {
    const data = await res.json()
    if (typeof data.detail === 'string') detail = data.detail
    else if (typeof data.error === 'string') detail = data.error
    if (typeof data.code === 'string') code = data.code
  } catch {}
  throw new ApiError(detail ?? `${action}: ${res.status}`, res.status, code)
}
