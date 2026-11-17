// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { TurnContext } from 'botbuilder'

export const REQUEST_AUTH_KEY = Symbol('bot.requestAuth')

/** Per-request credentials the edge resolved for the verified Teams user. */
export interface RequestAuth {
  /** Snowflake OAuth token for a linked user. */
  userToken?: string
  /** One-time sign-in code, present when the user is not linked. */
  linkCode?: string
  /** Set by the handler to ask the edge to drop this user's stored link. */
  unlink: boolean
}

export function getRequestAuth(ctx: TurnContext): RequestAuth {
  return (ctx.turnState.get(REQUEST_AUTH_KEY) as RequestAuth | undefined) ?? { unlink: false }
}

/** Thrown after the user has been told how to sign in; callers must not reply again. */
export class NotLinkedError extends Error {
  constructor() {
    super('Teams user has not linked a Snowflake identity')
    this.name = 'NotLinkedError'
  }
}
