// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('jose', async (orig) => {
  const actual = await orig<typeof import('jose')>()
  return { ...actual, jwtVerify: vi.fn(), createRemoteJWKSet: vi.fn(() => ({})) }
})

import { jwtVerify } from 'jose'
import { verifyBotRequest } from './bot-link'

const AUTH = 'Bearer aaa.bbb.ccc'
const ACTIVITY = { serviceUrl: 'https://smba.trafficmanager.net/teams/', type: 'message', from: { aadObjectId: 'o1' }, channelData: { tenant: { id: 't1' } } }

afterEach(() => vi.mocked(jwtVerify).mockReset())

describe('verifyBotRequest', () => {
  it('rejects a token with no serviceurl claim', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({ payload: {} } as never)
    expect(await verifyBotRequest(AUTH, 'app', ACTIVITY)).toBeNull()
  })

  it('rejects a serviceurl that does not match the activity', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({ payload: { serviceurl: 'https://other.example/' } } as never)
    expect(await verifyBotRequest(AUTH, 'app', ACTIVITY)).toBeNull()
  })

  it('rejects when jwtVerify fails (including a non-RS256 algorithm)', async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error('unexpected algorithm "HS256"'))
    expect(await verifyBotRequest(AUTH, 'app', ACTIVITY)).toBeNull()
    expect(vi.mocked(jwtVerify).mock.calls[0][2]).toMatchObject({ algorithms: ['RS256'], maxTokenAge: '1h' })
  })

  it('returns the activity identity when serviceurl matches', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({ payload: { serviceurl: ACTIVITY.serviceUrl } } as never)
    expect(await verifyBotRequest(AUTH, 'app', ACTIVITY)).toEqual({ tid: 't1', oid: 'o1' })
  })
})
