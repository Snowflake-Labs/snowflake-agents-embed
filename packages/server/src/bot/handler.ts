// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import {
  ActivityHandler, BotFrameworkAdapter, TurnContext, Activity
} from 'botbuilder'
import type { Config } from '../config.js'
import { streamCortexAgent, createCortexThread } from './cortex.js'
import { mergeCitations } from '@snowflake-agents-embed/chat-core/api/sseParser'
import type { Citation } from '@snowflake-agents-embed/chat-core/types'
import { buildSummaryCard, buildAgentListCard, buildStarterPromptsCard, buildSigninCard } from './cards.js'
import { NotLinkedError, getRequestAuth } from './request-auth.js'
import type { SummaryCardTable } from './cards.js'
import { buildDeepLinkServer, buildSigninDeepLink } from '../lib/deep-link.js'
import { decodeSnapshot } from '../lib/share-snapshot.js'
import { parseAgentRef, isAllowedAgent } from '@snowflake-agents-embed/cortex-server/snowflake/agent-ref'
import { listAgentsForUser } from '@snowflake-agents-embed/cortex-server/snowflake/list-agents'
import { getSampleQuestions } from '@snowflake-agents-embed/cortex-server/snowflake/agent-details'
import type { SnowflakeCredential } from '@snowflake-agents-embed/cortex-server/snowflake/credential'
import { getBotUserState, setBotUserState, type BotUserState } from '../lib/bot-state.js'

export function createBotAdapter(config: Config) {
  // SPCS egress enabled via AGENTS_TEAMS_EAI (network rule MSFT_EGRESS, which must include login.botframework.com).
  // channelAuthTenant is required for SingleTenant bots: token acquisition must use
  // the app's own tenant (not botframework.com which doesn't know our app).
  return new BotFrameworkAdapter({
    appId: config.botAppId,
    appPassword: config.botAppSecret,
    channelAuthTenant: config.tenantId,
  })
}

// Bot Framework Connector rate-limits activity updates; coalescing streamed deltas into at
// most one update per this interval keeps a long answer from firing dozens of PATCH calls.
const DEBUG_LOG_QUERIES = process.env.BOT_DEBUG_LOG_QUERIES === '1'

const UPDATE_INTERVAL_MS = 1500
const FINAL_UPDATE_RETRY_MS = 200

// Compose-extension invoke is a single synchronous Teams turn (15 s cap).
// Abort under that so we return the graceful "open the full app" copy instead
// of letting Teams fail the invoke first. The incremental message path owns
// its own activity updates and can legitimately outlive a turn.
const COMPOSE_EXTENSION_TIMEOUT_MS = 12_000
const MESSAGE_STREAM_TIMEOUT_MS = 55_000

/** Same sentence the relay appends to a truncated aggregate answer. */
export const BOT_TRUNCATION_MARKER =
  'This answer was cut short — the agent was still working.'

export class AgentsEmbedBot extends ActivityHandler {
  // In-process cache over lib/bot-state.ts's Snowflake-table-backed state - this used to be
  // the only copy (in-memory Maps, lost on every container restart/scale-out, which is
  // routine on SPCS). Now it's just a fast path: reads/writes go through to the table too, so
  // a fresh container hydrates itself lazily on that user's next message.
  private stateCache = new Map<string, BotUserState>()
  /** Successful reads only — a failed read must not latch, so the next turn retries. */
  private hydrated = new Set<string>()
  /** Last hydration attempt failed; persistState must not MERGE a half-empty row. */
  private hydrationFailed = new Set<string>()

  constructor(private config: Config) {
    super()
    this.onMessage(async (ctx, next) => {
      await this.handleMessage(ctx)
      await next()
    })
    this.onMembersAdded(async (ctx, next) => {
      await this.handleMembersAdded(ctx).catch((e: unknown) => console.error(`[bot] membersAdded error: ${e}`))
      await next()
    })
  }

  // Fixed user-facing error text: upstream Snowflake/Cortex messages can carry object names,
  // so the detail goes to the server log under a correlation id the user can quote.
  private failure(scope: string, err: unknown): string {
    const ref = randomUUID().slice(0, 8)
    console.error(`[bot] ${scope} failed ref=${ref}: ${err instanceof Error ? err.message : String(err)}`)
    return `Something went wrong talking to the agent (ref ${ref}). Try again, or continue in the app.`
  }

  private resolveAgent(userId: string): string {
    const stored = this.stateCache.get(userId)?.agentFqn
    if (stored) {
      try {
        parseAgentRef(stored)
        return stored
      } catch {
        console.warn(`[bot] ignoring invalid persisted agent for ${userId}`)
      }
    }
    return this.config.defaultAgentFqn
  }

  // Returns the user's Snowflake credential, or tells them how to sign in and throws
  // NotLinkedError (the caller must then stop without sending another message).
  private async resolveSnowflakeAuth(
    ctx: TurnContext,
    { promptSignIn = true }: { promptSignIn?: boolean } = {},
  ): Promise<SnowflakeCredential> {
    if (this.config.authMode === 'local-pat') {
      return { token: process.env.SNOWFLAKE_PAT!, tokenType: 'PROGRAMMATIC_ACCESS_TOKEN' }
    }
    const { userToken, linkCode } = getRequestAuth(ctx)
    if (userToken) return { token: userToken, tokenType: 'OAUTH' }

    if (promptSignIn) {
      if (linkCode) {
        const url = buildSigninDeepLink(this.config.teamsAppId, linkCode)
        await ctx.sendActivity({ attachments: [buildSigninCard(url)] } as Partial<Activity>)
      } else {
        await ctx.sendActivity('Sign-in is not available for this bot right now. Use the Snowflake Agent for Teams tab instead.')
      }
    }
    throw new NotLinkedError()
  }

  // Lazily loads this user's state from Snowflake the first time it's needed in this
  // process's lifetime - after that, the cache is authoritative for this process and every
  // write goes through to the table so the *next* process (restart/scale-out) sees it too.
  private newThreadId(auth: SnowflakeCredential) {
    return createCortexThread({
      snowflakeToken: auth.token,
      snowflakeAccount: this.config.snowflakeAccount,
      tokenType: auth.tokenType,
      originApp: 'agents_teams',
    })
  }

  private async ensureHydrated(userId: string, auth: SnowflakeCredential) {
    if (this.hydrated.has(userId)) return
    try {
      const result = await getBotUserState(this.config.snowflakeAccount, auth.token, auth.tokenType, this.config.botStateTable, userId)
      if (!result.ok) {
        this.hydrationFailed.add(userId)
        console.warn(`[bot] hydration failed for ${userId}; will retry next turn`)
        return
      }
      this.hydrationFailed.delete(userId)
      this.hydrated.add(userId)
      if (result.state) this.stateCache.set(userId, result.state)
    } catch (err: unknown) {
      this.hydrationFailed.add(userId)
      console.warn(`[bot] hydration threw for ${userId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async persistState(userId: string, ctx: TurnContext, auth: SnowflakeCredential, patch: BotUserState): Promise<boolean> {
    // Captured on every persist (not just once) since a conversation reference can go stale
    // (e.g. the user re-adds the app) - the freshest one is always the one from the message
    // that's currently being handled.
    const conversationReference = JSON.stringify(TurnContext.getConversationReference(ctx.activity))
    const next = { ...patch, conversationReference }
    this.stateCache.set(userId, next)
    if (this.hydrationFailed.has(userId)) {
      console.warn(`[bot] skip persist for ${userId}: hydration failed; will not blank stored state`)
      return false
    }
    return setBotUserState(this.config.snowflakeAccount, auth.token, auth.tokenType, this.config.botStateTable, userId, next)
  }

  // Handle invoke activities (e.g. composeExtension/queryLink for link unfurling,
  // composeExtension/query for the "Ask Snowflake Agent" search command).
  protected async onInvokeActivity(ctx: TurnContext) {
    if (ctx.activity.name === 'composeExtension/queryLink') {
      return this.handleQueryLink(ctx)
    }
    if (ctx.activity.name === 'composeExtension/query') {
      return this.handleComposeQuery(ctx)
    }
    return super.onInvokeActivity(ctx)
  }

  // A compose-extension search command can't do the progressive updates callAndReply does -
  // Teams expects one response for the whole invoke - so this drains the stream to completion
  // server-side first. Reuses the same agent/thread state as the conversational path (keyed by
  // the same userId), so a query asked here still chains onto that user's ongoing thread.
  private async handleComposeQuery(ctx: TurnContext) {
    const userId = ctx.activity.from.id
    const params = (ctx.activity.value as any)?.parameters as { name: string; value: string }[] | undefined
    const query = params?.find((p) => p.name === 'query')?.value?.trim() ?? ''
    if (!query) {
      return { status: 200, body: { composeExtension: { type: 'result', attachmentLayout: 'list', attachments: [] } } }
    }

    let auth: SnowflakeCredential
    try {
      auth = await this.resolveSnowflakeAuth(ctx, { promptSignIn: false })
    } catch (err: unknown) {
      if (!(err instanceof NotLinkedError)) throw err
      // An invoke gets exactly one response, so the sign-in link goes in it as text.
      const { linkCode } = getRequestAuth(ctx)
      const text = linkCode
        ? `Sign in to Snowflake to search: ${buildSigninDeepLink(this.config.teamsAppId, linkCode)}`
        : 'Sign-in is not available for this bot right now.'
      return { status: 200, body: { composeExtension: { type: 'message', text } } }
    }
    await this.ensureHydrated(userId, auth)
    let answer = ''
    // Every question is its own Cortex session; follow-ups happen in the tab via the card's deep link.
    let threadId: number | undefined = await this.newThreadId(auth)
    try {
      for await (const e of streamCortexAgent({
        agent: parseAgentRef(this.resolveAgent(userId)),
        query,
        snowflakeToken: auth.token,
        snowflakeAccount: this.config.snowflakeAccount,
        tokenType: auth.tokenType,
        threadId,
        timeoutMs: COMPOSE_EXTENSION_TIMEOUT_MS,
      })) {
        switch (e.kind) {
          case 'text.delta': answer += e.text; break
          case 'text': answer = e.text; break
          case 'metadata':
          case 'final':
            if (e.threadId) threadId = e.threadId
            break
        }
      }
    } catch (err: any) {
      answer = err.name === 'AbortError'
        ? 'This is taking longer than expected — open the full app to continue.'
        : this.failure('compose query', err)
    }

    const deepLink = buildDeepLinkServer(this.config.teamsAppId, threadId)
    const card = buildSummaryCard({ question: query, summary: answer, deepLink })
    return {
      status: 200,
      body: {
        composeExtension: {
          type: 'result',
          attachmentLayout: 'list',
          attachments: [{ ...card, preview: card }],
        },
      },
    }
  }

  private async handleQueryLink(ctx: TurnContext) {
    const url: string = (ctx.activity.value as any)?.url ?? ''
    let snapshotParam: string | null = null
    let sig: string | null = null
    try {
      const params = new URL(url).searchParams
      snapshotParam = params.get('s')
      sig = params.get('sig')
    } catch { /* malformed URL */ }

    const noCard = { status: 200, body: { composeExtension: { type: 'result', attachmentLayout: 'list', attachments: [] } } }
    if (!snapshotParam) return noCard

    const snapshot = decodeSnapshot(snapshotParam, sig, this.config.shareSigningSecret)
    // Unsigned/forged/undecodable snapshots come back empty: show nothing rather than an
    // official-looking card with attacker-chosen content.
    if (!snapshot.answer && !snapshot.title && !snapshot.question) return noCard
    const deepLink = buildDeepLinkServer(this.config.teamsAppId, snapshot.threadId)
    const card = buildSummaryCard({
      title: snapshot.title,
      question: snapshot.question,
      summary: snapshot.answer ?? '',
      deepLink,
    })

    return {
      status: 200,
      body: {
        composeExtension: {
          type: 'result',
          attachmentLayout: 'list',
          attachments: [card],
        },
      },
    }
  }

  private async handleMessage(ctx: TurnContext) {
    const userId = ctx.activity.from.id

    // Action.Submit from agent-picker card → selectAgent
    const selectAgent = (ctx.activity.value as any)?.selectAgent
    if (selectAgent) {
      console.log('[bot] selectAgent')
      return this.handleAgentSelect(ctx, userId, String(selectAgent)).catch((e: unknown) => {
        console.error(`[bot] handleAgentSelect error: ${e}`)
      })
    }

    // Action.Submit from starter-prompts card → treat as a regular query
    const sendMessage = (ctx.activity.value as any)?.sendMessage
    if (sendMessage) {
      return this.callAndReply(ctx, userId, String(sendMessage))
    }

    const query = ctx.activity.text?.replace(/<at>[^<]+<\/at>/g, '').trim() ?? ''
    if (DEBUG_LOG_QUERIES) console.log(`[bot] message userId=${userId} query="${query.slice(0, 80)}"`)
    if (!query) return

    const cmd = query.toLowerCase()

    if (cmd === 'help' || cmd === '/help') {
      return this.handleHelpCommand(ctx).catch((e: unknown) => console.error(`[bot] help error: ${e}`))
    }
    if (cmd === 'choose agent' || cmd === '/agents' || cmd === '/choose agent') {
      return this.handleAgentsCommand(ctx, userId).catch((e: unknown) => console.error(`[bot] agentsCmd error: ${e}`))
    }
    if (cmd === 'starter prompts' || cmd === '/starters' || cmd === '/starter prompts') {
      return this.handleStarterPromptsCommand(ctx, userId).catch((e: unknown) => console.error(`[bot] startersCmd error: ${e}`))
    }

    if (cmd === 'sign out' || cmd === '/signout' || cmd === '/sign out') {
      return this.handleSignOutCommand(ctx).catch((e: unknown) => console.error(`[bot] signOut error: ${e}`))
    }

    return this.callAndReply(ctx, userId, query)
  }

  private async handleSignOutCommand(ctx: TurnContext) {
    if (this.config.authMode === 'local-pat') {
      await ctx.sendActivity('This bot uses a shared Snowflake credential, so there is nothing to sign out of.')
      return
    }
    // The edge deletes the stored link when it sees this on the response.
    getRequestAuth(ctx).unlink = true
    await ctx.sendActivity('Signed out. Your next question will ask you to sign in again.')
  }

  // Streams the agent run incrementally (reusing chat-core's parseSseEvent via
  // streamCortexAgent) instead of buffering the whole answer and hitting a fixed timeout on
  // anything slower than that - posts once as soon as text starts arriving, then updates that
  // same activity in place as more streams in, throttled to UPDATE_INTERVAL_MS.
  private async callAndReply(ctx: TurnContext, userId: string, query: string) {
    let auth: SnowflakeCredential
    try {
      auth = await this.resolveSnowflakeAuth(ctx)
      await this.ensureHydrated(userId, auth)
    } catch (err: unknown) {
      // The sign-in card has already been sent.
      if (err instanceof NotLinkedError) return
      console.warn(`[bot] auth failed: ${err instanceof Error ? err.message : String(err)}`)
      // Reply once and stop: rethrowing would make onTurnError send a second message.
      await ctx.sendActivity("I couldn't reach Snowflake — your sign-in may have expired. Try again in a moment.")
      return
    }
    if (DEBUG_LOG_QUERIES) console.log(`[bot] query agent=${this.resolveAgent(userId)} query="${query.slice(0, 60)}"`)

    // Typing indicator is best-effort — don't let 401 from Bot Connector abort the reply.
    await ctx.sendActivity({ type: 'typing' }).catch((e: unknown) => {
      console.warn(`[bot] typing indicator failed: ${e instanceof Error ? e.message : String(e)}`)
    })

    let answer = ''
    // Every question is its own Cortex session; follow-ups happen in the tab via the card's deep link.
    let threadId: number | undefined = await this.newThreadId(auth)
    let hasChart = false
    let table: SummaryCardTable | undefined
    let citations: Citation[] = []
    let sentActivityId: string | undefined
    let lastUpdateAt = 0

    const postPlainFallback = async (deepLink: string) => {
      const text = answer
        ? `${answer}\n\nOpen the full answer in the app: ${deepLink}`
        : `Something went wrong posting the answer. Continue in the app: ${deepLink}`
      await ctx.sendActivity(text).catch((e: unknown) => {
        console.warn(`[bot] plain-text fallback failed: ${e instanceof Error ? e.message : String(e)}`)
      })
    }

    const postOrUpdate = async (force = false) => {
      const now = Date.now()
      if (!force && now - lastUpdateAt < UPDATE_INTERVAL_MS) return
      lastUpdateAt = now
      const deepLink = buildDeepLinkServer(this.config.teamsAppId, threadId)
      const card = buildSummaryCard({
        question: query, summary: answer || '…', deepLink, hasChart, table,
        citations: citations.length ? citations.map((c) => ({ index: c.index, docTitle: c.docTitle, url: c.url })) : undefined,
      })
      const payload = { attachments: [card] } as Partial<Activity>

      if (!sentActivityId) {
        try {
          const res = await ctx.sendActivity(payload)
          sentActivityId = res?.id
        } catch (e: unknown) {
          console.warn(`[bot] sendActivity failed: ${e instanceof Error ? e.message : String(e)}`)
          if (force) await postPlainFallback(deepLink)
        }
        return
      }

      const patch = { id: sentActivityId, type: 'message', attachments: [card] } as Activity
      if (!force) {
        await ctx.updateActivity(patch).catch((e: unknown) => {
          console.warn(`[bot] updateActivity failed: ${e instanceof Error ? e.message : String(e)}`)
        })
        return
      }

      try {
        await ctx.updateActivity(patch)
        return
      } catch (first: unknown) {
        console.warn(`[bot] final updateActivity failed: ${first instanceof Error ? first.message : String(first)}`)
      }
      await new Promise((r) => setTimeout(r, FINAL_UPDATE_RETRY_MS))
      try {
        await ctx.updateActivity(patch)
        return
      } catch (retry: unknown) {
        console.warn(`[bot] final updateActivity retry failed: ${retry instanceof Error ? retry.message : String(retry)}`)
      }
      try {
        const res = await ctx.sendActivity(payload)
        sentActivityId = res?.id
      } catch (sendErr: unknown) {
        console.warn(`[bot] final sendActivity fallback failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`)
        await postPlainFallback(deepLink)
      }
    }

    try {
      const stream = streamCortexAgent({
        agent: parseAgentRef(this.resolveAgent(userId)),
        query,
        snowflakeToken: auth.token,
        snowflakeAccount: this.config.snowflakeAccount,
        tokenType: auth.tokenType,
        threadId,
        timeoutMs: MESSAGE_STREAM_TIMEOUT_MS,
      })
      for await (const e of stream) {
        switch (e.kind) {
          case 'text.delta': answer += e.text; await postOrUpdate(); break
          case 'text':
            answer = e.text
            if (e.annotations) citations = mergeCitations(citations, e.annotations)
            await postOrUpdate()
            break
          case 'chart': hasChart = true; break
          case 'table': table = { rowType: e.rowType, data: e.data, numRows: e.numRows }; break
          case 'annotation': citations = mergeCitations(citations, [e.citation]); break
          case 'metadata':
          case 'final':
            if (e.threadId) threadId = e.threadId
            break
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        answer = answer
          ? `${answer.trimEnd()}\n\n${BOT_TRUNCATION_MARKER}`
          : 'This is taking longer than expected — open the full app to continue.'
      } else if (!sentActivityId) {
        await ctx.sendActivity(this.failure('agent run', err))
        return
      } else {
        answer = answer || this.failure('agent run', err)
      }
    }

    await postOrUpdate(true)
  }

  // Fires on every conversationUpdate with membersAdded, including the bot's own install
  // event (recipient.id) and other users joining a group/channel it's already in - only
  // the former should trigger a welcome.
  private async handleMembersAdded(ctx: TurnContext) {
    const botId = ctx.activity.recipient?.id
    const added = ctx.activity.membersAdded ?? []
    if (!added.some((m) => m.id === botId)) return

    const agentFqn = this.config.defaultAgentFqn
    const agentName = agentFqn.split('.').pop() ?? agentFqn
    await ctx.sendActivity(
      `👋 I'm **Snowflake Agent for Teams (Unofficial)**, connected to the **${agentName}** Cortex Agent. Ask me anything, or try:\n\n` +
      '• `help` — Show all commands\n' +
      '• `choose agent` — Switch the Cortex Agent you\'re chatting with\n' +
      '• `starter prompts` — See example questions for the current agent\n' +
      '• `sign out` — Unlink your Snowflake account from this bot',
    )

    let questions: string[] = []
    try {
      const auth = await this.resolveSnowflakeAuth(ctx, { promptSignIn: false })
      questions = await getSampleQuestions(this.config.snowflakeAccount, auth, agentFqn)
    } catch (err: unknown) {
      console.warn(`[bot] welcome getSampleQuestions failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (questions.length) {
      await ctx.sendActivity({ attachments: [buildStarterPromptsCard(agentName, questions)] } as Partial<Activity>)
    }
  }

  private async handleHelpCommand(ctx: TurnContext) {
    await ctx.sendActivity(
      '**Available commands**\n\n' +
      '• `help` — Show this list\n' +
      '• `choose agent` — Switch the Cortex Agent you\'re chatting with\n' +
      '• `starter prompts` — See example questions for the current agent\n' +
      '• `sign out` — Unlink your Snowflake account from this bot',
    )
  }

  private async handleAgentsCommand(ctx: TurnContext, userId: string) {
    const auth = await this.resolveSnowflakeAuth(ctx)
    await this.ensureHydrated(userId, auth)

    let agents = this.config.agentAllowList
    console.log(`[bot] handleAgentsCommand discovery=${this.config.agentDiscovery} allowList=${agents.length}`)
    if (this.config.agentDiscovery === 'dynamic') {
      try {
        agents = await listAgentsForUser(this.config.snowflakeAccount, auth)
        console.log(`[bot] listAgentsForUser returned ${agents.length} agents`)
      } catch (err: unknown) {
        console.warn(`[bot] listAgentsForUser failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (!agents.length) {
      await ctx.sendActivity('No agents available.')
      return
    }

    console.log(`[bot] sending agent list card with ${agents.length} agents`)
    await ctx.sendActivity({
      attachments: [buildAgentListCard(agents, this.resolveAgent(userId))],
    } as Partial<Activity>)
  }

  private async handleStarterPromptsCommand(ctx: TurnContext, userId: string) {
    const auth = await this.resolveSnowflakeAuth(ctx)
    await this.ensureHydrated(userId, auth)

    const agentFqn = this.resolveAgent(userId)
    const agentName = agentFqn.split('.').pop() ?? agentFqn

    let questions: string[] = []
    try {
      questions = await getSampleQuestions(this.config.snowflakeAccount, auth, agentFqn)
    } catch (err: unknown) {
      console.warn(`[bot] getSampleQuestions failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    await ctx.sendActivity({
      attachments: [buildStarterPromptsCard(agentName, questions)],
    } as Partial<Activity>)
  }

  private async handleAgentSelect(ctx: TurnContext, userId: string, fqn: string) {
    try {
      parseAgentRef(fqn)
    } catch {
      await ctx.sendActivity('Invalid agent name.')
      return
    }

    if (this.config.agentDiscovery === 'static' && !isAllowedAgent(fqn, this.config.agentAllowList)) {
      await ctx.sendActivity('That agent is not available.')
      return
    }

    const auth = await this.resolveSnowflakeAuth(ctx)
    await this.ensureHydrated(userId, auth)
    // Switching agents clears thread context — new agent = new conversation.
    const persisted = await this.persistState(userId, ctx, auth, { agentFqn: fqn })
    const name = fqn.split('.').pop() ?? fqn
    await ctx.sendActivity(
      persisted
        ? `Switched to **${name}**. Your next message will use this agent.`
        : `Switched to **${name}** for this session; I couldn't save it as your default.`,
    )
  }
}
