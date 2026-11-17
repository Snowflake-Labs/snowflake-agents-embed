// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { BotFrameworkAdapter, Activity, ConversationReference } from 'botbuilder'

/**
 * Sends a message to a user without them having messaged first - the prerequisite for
 * "proactive messaging on automation completion" from the gap-closure plan. `reference` is the
 * JSON-serialized `TurnContext.getConversationReference()` captured from that user's last
 * message (see bot/handler.ts persisting it via lib/bot-state.ts).
 *
 * This function is the *mechanism*, not the trigger: nothing in this codebase currently calls
 * it. Wiring an actual "an automation finished" event (polling Snowflake task history, or some
 * other completion signal) is separate, unbuilt work - the master plan itself notes proactive
 * messaging only needs the conversation-reference storage as a prerequisite, not that this
 * mechanism alone delivers the feature.
 */
export async function sendProactiveMessage(
  adapter: BotFrameworkAdapter,
  reference: Partial<ConversationReference>,
  activity: Partial<Activity>,
): Promise<void> {
  await adapter.continueConversation(reference, async (ctx) => {
    await ctx.sendActivity(activity)
  })
}
