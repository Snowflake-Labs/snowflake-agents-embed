// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { sendProactiveMessage } from './proactive.js'

describe('sendProactiveMessage', () => {
  it('delegates to adapter.continueConversation, sending the activity through the resumed context', async () => {
    let capturedLogic: ((ctx: any) => Promise<void>) | undefined
    const adapter: any = {
      continueConversation: vi.fn((_ref: unknown, logic: (ctx: any) => Promise<void>) => {
        capturedLogic = logic
        return Promise.resolve()
      }),
    }
    const reference: any = { user: { id: 'user1' }, conversation: { id: 'conv1' } }
    const activity = { type: 'message', text: 'Your task finished.' }

    await sendProactiveMessage(adapter, reference, activity)

    expect(adapter.continueConversation).toHaveBeenCalledWith(reference, expect.any(Function))

    const sendActivity = vi.fn().mockResolvedValue(undefined)
    await capturedLogic!({ sendActivity })
    expect(sendActivity).toHaveBeenCalledWith(activity)
  })

  it('propagates a failure from continueConversation rather than swallowing it', async () => {
    const adapter: any = { continueConversation: vi.fn().mockRejectedValue(new Error('no such conversation')) }
    await expect(sendProactiveMessage(adapter, {}, { type: 'message', text: 'x' })).rejects.toThrow('no such conversation')
  })
})
