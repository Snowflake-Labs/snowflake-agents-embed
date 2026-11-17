// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { decodeJwtPayload, nameFromUpn, nameFromEntraToken, resolveUserName } from './teamsUserName'
import { TEST_USER_NAME, TEST_USER_UPN } from '../test/identities'

function fakeJwt(claims: Record<string, unknown>): string {
  const body = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${body}.signature`
}

describe('decodeJwtPayload', () => {
  it('decodes a base64url payload', () => {
    expect(decodeJwtPayload(fakeJwt({ name: TEST_USER_NAME }))).toEqual({ name: TEST_USER_NAME })
  })

  it('returns undefined for a missing, malformed, or non-JSON token', () => {
    expect(decodeJwtPayload()).toBeUndefined()
    expect(decodeJwtPayload('not-a-jwt')).toBeUndefined()
    expect(decodeJwtPayload('header.!!!not-base64!!!.sig')).toBeUndefined()
    expect(decodeJwtPayload(`header.${btoa('"just-a-string"')}.sig`)).toBeUndefined()
  })
})

describe('nameFromUpn', () => {
  it('humanizes the local part', () => {
    expect(nameFromUpn(TEST_USER_UPN)).toBe(TEST_USER_NAME)
    expect(nameFromUpn('jane_doe@example.com')).toBe(TEST_USER_NAME)
    expect(nameFromUpn('jane-doe@example.com')).toBe(TEST_USER_NAME)
    expect(nameFromUpn('jane@example.com')).toBe('Jane')
  })

  it('drops numeric-only segments', () => {
    expect(nameFromUpn('jane.doe.2@example.com')).toBe(TEST_USER_NAME)
  })

  it('returns undefined when there is nothing usable', () => {
    expect(nameFromUpn()).toBeUndefined()
    expect(nameFromUpn('')).toBeUndefined()
    expect(nameFromUpn('@example.com')).toBeUndefined()
  })
})

describe('nameFromEntraToken', () => {
  it('prefers the name claim', () => {
    expect(nameFromEntraToken(fakeJwt({ name: TEST_USER_NAME, given_name: 'Jane' }))).toBe(TEST_USER_NAME)
  })

  it('falls back to given_name, then to the username claims', () => {
    expect(nameFromEntraToken(fakeJwt({ given_name: 'Jane' }))).toBe('Jane')
    expect(nameFromEntraToken(fakeJwt({ preferred_username: TEST_USER_UPN }))).toBe(TEST_USER_NAME)
    expect(nameFromEntraToken(fakeJwt({ upn: TEST_USER_UPN }))).toBe(TEST_USER_NAME)
  })

  it('returns undefined for a malformed token or claimless payload', () => {
    expect(nameFromEntraToken('garbage')).toBeUndefined()
    expect(nameFromEntraToken(fakeJwt({ sub: 'abc' }))).toBeUndefined()
  })
})

describe('resolveUserName', () => {
  it('prefers the Teams displayName', () => {
    expect(resolveUserName({
      displayName: TEST_USER_NAME,
      tokenName: 'Token Name',
      userPrincipalName: 'upn.name@example.com',
    })).toBe(TEST_USER_NAME)
  })

  it('falls back to the token-derived name when displayName is absent', () => {
    expect(resolveUserName({
      tokenName: TEST_USER_NAME,
      userPrincipalName: 'upn.name@example.com',
    })).toBe(TEST_USER_NAME)
  })

  it('falls back to the UPN, then the login hint', () => {
    expect(resolveUserName({ userPrincipalName: TEST_USER_UPN })).toBe(TEST_USER_NAME)
    expect(resolveUserName({ loginHint: TEST_USER_UPN })).toBe(TEST_USER_NAME)
  })

  it('returns undefined when no source has anything', () => {
    expect(resolveUserName({})).toBeUndefined()
    expect(resolveUserName({ displayName: '   ' })).toBeUndefined()
  })
})
