// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useCallback, useMemo, useState } from 'react'
import type { ComponentType } from 'react'
import { v4 as uuid } from 'uuid'
import { ConversationTurn } from './ConversationTurn.js'
import { MessageInput } from './MessageInput.js'
import { EmptyState } from './EmptyState.js'
import { StopButton } from './StopButton.js'
import { ChatControls } from '../ChatControls.js'
import { ForkSwitcher } from './ForkSwitcher.js'
import type { ShareButtonSlotProps } from './MessageActions.js'
import { useChatStore, ROOT_FORK_KEY } from '../../store/chatStore.js'
import { useAgentStream } from '../../hooks/useAgentStream.js'
import { useRefreshThread } from '../../hooks/useRefreshThread.js'
import { useBeforeUnloadWarning } from '../../hooks/useBeforeUnloadWarning.js'
import { fetchSampleQuestionsCached } from '../../api/agents.js'
import type { AgentSkillInfo } from '../../api/agents.js'
import { createThread, generateTitle, renameThread } from '../../api/threads.js'
import { submitFeedback } from '../../api/feedback.js'
import { setThreadAgent } from '../../lib/threadAgents.js'
import { buildSkillPreamble } from '../../lib/skillPreamble.js'
import type { Artifact, Citation, FileAttachment, ConversationTurn as ConversationTurnType } from '../../types.js'

const NO_TURNS: ConversationTurnType[] = []

interface Props {
  snowflakeToken: string
  /**
   * True once the host session has landed and the relay is addressable.
   *
   * Deliberately NOT derived from `snowflakeToken`. In phase 1 the browser holds no
   * Snowflake credential at all - the relay uses its own service identity and the SPA
   * authenticates with the shared secret in `relayHeaders` - so the token is '' on a
   * perfectly healthy session. Gating on it left the composer permanently disabled,
   * threads uncreated and sample questions unfetched.
   */
  connected: boolean
  ShareButton: ComponentType<ShareButtonSlotProps>
  /** Host-specific: tells the agent what record/context the user is looking at (ui only). */
  buildContextPreamble?: () => string | undefined
  /** The signed-in user's display name, if the host has one (tab only for now). */
  currentUserName?: string
  onArtifactOpen?: () => void
}

export function ChatContainer({ snowflakeToken, connected, ShareButton, buildContextPreamble, currentUserName, onArtifactOpen }: Props) {
  // Scoped subscriptions, not `useChatStore()`. This component re-renders on every (coalesced)
  // delta because it owns the transcript, which is fine - but an unscoped subscription also
  // re-ran on unrelated store changes, and pulled the whole `openThreads` map into the
  // dependency of every callback below.
  const activeThreadTempId = useChatStore((s) => s.activeThreadTempId)
  const activeThread = useChatStore((s) => (s.activeThreadTempId ? s.openThreads[s.activeThreadTempId] : null)) ?? null
  const threadSummaries = useChatStore((s) => s.threadSummaries)
  // Actions have stable identities in zustand, so these never trigger a re-render.
  const appendTurn = useChatStore((s) => s.appendTurn)
  const setThreadId = useChatStore((s) => s.setThreadId)
  const upsertSummary = useChatStore((s) => s.upsertSummary)
  const selectArtifact = useChatStore((s) => s.selectArtifact)
  const selectCitations = useChatStore((s) => s.selectCitations)
  const forkAt = useChatStore((s) => s.forkAt)
  const switchFork = useChatStore((s) => s.switchFork)

  const { stream, stop } = useAgentStream(snowflakeToken)
  const refreshThread = useRefreshThread(snowflakeToken)
  const listRef = useRef<HTMLDivElement>(null)
  // Whether the user is parked at the bottom. Streaming should follow the text only when
  // they are already there; yanking the view while they are reading earlier output is
  // exactly the behaviour that made a long answer unreadable.
  const stickToBottom = useRef(true)
  const sentInitial = useRef(false)
  // The record context already told to the agent, per thread. Keyed by tempId so switching
  // threads re-states it: `<tempId>` -> the preamble string that was sent.
  const sentPreamble = useRef<Record<string, string>>({})
  // Per-agent starter questions, keyed by agent FQN (fetched lazily, cached).
  const [sampleQuestions, setSampleQuestions] = useState<Record<string, string[]>>({})

  // Load the active agent's sample questions once per FQN
  const activeAgentFqn = activeThread?.agentFqn
  useEffect(() => {
    if (!connected || !activeAgentFqn || activeAgentFqn in sampleQuestions) return
    fetchSampleQuestionsCached(snowflakeToken, activeAgentFqn)
      .then((questions) => setSampleQuestions((prev) => ({ ...prev, [activeAgentFqn]: questions })))
      .catch(() => {})
  }, [connected, snowflakeToken, activeAgentFqn, sampleQuestions])

  /**
   * Follow the transcript as it streams - by scrolling the message list itself.
   *
   * NOT `scrollIntoView`: this app runs in an iframe, and scrollIntoView walks every
   * ancestor scrolling box, including the *host document's*. In Lightning that scrolled
   * the whole record page to the bottom on every SSE chunk, so the user could not see
   * what they were reading. Setting scrollTop on the one container we own cannot escape
   * the frame.
   */
  const turnsSignal = activeThread?.turns
  useEffect(() => {
    const list = listRef.current
    if (!list || !stickToBottom.current) return
    list.scrollTop = list.scrollHeight
  }, [turnsSignal])

  const handleListScroll = useCallback(() => {
    const list = listRef.current
    if (!list) return
    // 40px of slack: a streaming line can land between the scroll event and this read.
    stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40
  }, [])

  useEffect(() => {
    // send initial query from deep-link once auth + thread is ready (legacy path)
    if (sentInitial.current) return
    sentInitial.current = true
  })

  // Reads the active thread via getState() rather than closing over the render-time value.
  // Two reasons: it can't go stale between render and send, and - because it's passed down to
  // every ConversationTurn as `onSuggestion` - a dependency on `activeThread` would give this
  // callback a new identity on every streamed delta, defeating the memo on ConversationTurn.
  // The same reasoning applies to handleFeedback and handleRefreshThread below.
  const sendMessage = useCallback(async (text: string, attachments?: FileAttachment[], skills?: AgentSkillInfo[]) => {
    const st = useChatStore.getState()
    const current = st.activeThreadTempId ? st.openThreads[st.activeThreadTempId] : null
    if (!current) return
    const { tempId, agentFqn, thread } = current
    const isFirstTurn = current.turns.length === 0
    // Sending is an explicit "show me the answer", so re-arm the follow-the-stream
    // behaviour even if the user had scrolled up to read something earlier.
    stickToBottom.current = true
    appendTurn(tempId, {
      id: uuid(), role: 'user', steps: [], text, citations: [], artifacts: [], status: 'done',
    })

    let threadId = thread.threadId
    if (!threadId && connected) {
      try {
        const created = await createThread(snowflakeToken)
        threadId = created.thread_id
        setThreadAgent(threadId, agentFqn)
        setThreadId(tempId, threadId)
        // Upsert immediately with the real created_at/updated_at, so the sidebar shows a
        // correctly-dated row from the moment the thread exists rather than leaving it
        // undated until the rename below lands (or the next full listThreads()).
        upsertSummary(created)
      } catch { /* fall back to stateless single-turn */ }
    }

    if (threadId && isFirstTurn && connected) {
      const tid = threadId
      void (async () => {
        try {
          const title = await generateTitle(snowflakeToken, text)
          if (!title) return
          await renameThread(snowflakeToken, tid, title)
          upsertSummary({ thread_id: tid, thread_name: title })
        } catch { /* leave unnamed */ }
      })()
    }

    // On a record page, tell the agent what the user is looking at.
    //
    // Sent as a preamble on the query rather than as a system message: the agent's
    // instructions live in its spec server-side in Snowflake and stay authoritative. It is
    // also why the preamble is prepended to `query` only - the turn rendered in the
    // transcript, and the text the auto-title is generated from, are what the user typed.
    //
    // Re-stated whenever it changes rather than only on the first turn. A restored thread
    // (the utility bar and record pages resume where the user left off) can come back on a
    // different record, and the agent has no way to know that from the thread alone.
    //
    // Date/user are NOT on the query: prefixing them made Cortex miss the verified-query
    // exact-match path. They go out as experimental metadata on the :run body instead
    // (see buildClientDateContext / streamAgentRun).
    const preamble = buildContextPreamble?.()
    let query = text
    if (preamble && sentPreamble.current[tempId] !== preamble) {
      sentPreamble.current[tempId] = preamble
      query = `${preamble}\n\n${text}`
    }
    // Skills are an explicit, one-shot user action (via the SkillPicker) rather than
    // ambient state, so - unlike the date/context preamble above - they're never cached
    // in sentPreamble and never auto-resent on a later turn.
    const skillPreamble = buildSkillPreamble(skills)
    if (skillPreamble) {
      query = `${skillPreamble}\n\n${query}`
    }

    await stream({
      tempId,
      query,
      agentFqn,
      threadId,
      parentMessageId: thread.lastAssistantMessageId,
      attachments,
      currentUserName,
    })
  }, [appendTurn, setThreadId, upsertSummary, stream, snowflakeToken, connected, currentUserName, buildContextPreamble])

  const handleArtifactClick = useCallback((artifact: Artifact) => {
    selectArtifact(artifact)
    onArtifactOpen?.()
  }, [selectArtifact, onArtifactOpen])

  const handleFeedback = useCallback((positive: boolean, categories?: string[], comment?: string) => {
    const st = useChatStore.getState()
    const current = st.activeThreadTempId ? st.openThreads[st.activeThreadTempId] : null
    const agentFqn = current?.agentFqn
    if (!agentFqn) return
    void submitFeedback(snowflakeToken, { agentFqn, positive, categories, feedbackMessage: comment, threadId: current?.threadId })
  }, [snowflakeToken])

  const handleCitationsClick = useCallback((citations: Citation[]) => {
    selectCitations(citations)
    onArtifactOpen?.()
  }, [selectCitations, onArtifactOpen])

  // Stable identity for the empty case, so the turnPairing useMemo below doesn't recompute on
  // every render just because `?? []` allocated a fresh array.
  const turns = activeThread?.turns ?? NO_TURNS
  const isStreaming = activeThread?.isStreaming ?? false
  useBeforeUnloadWarning(isStreaming)

  const handleRefreshThread = useCallback(() => {
    const st = useChatStore.getState()
    const current = st.activeThreadTempId ? st.openThreads[st.activeThreadTempId] : null
    if (!current?.threadId) return
    void refreshThread(current.tempId, current.threadId)
  }, [refreshThread])

  // Edit and per-message regenerate both drop a turn (and everything after it) via forkAt,
  // then re-stream - the difference is only whether a fresh user turn is appended first.
  // Read the post-fork state via getState() rather than the `store`/`activeThread` closures:
  // those were captured at render time, before forkAt's synchronous set() lands, so trusting
  // them here would chain the new turn off the branch that was just replaced.
  const handleEditMessage = useCallback((turnId: string, newText: string) => {
    const tempId = activeThreadTempId
    if (!tempId) return
    forkAt(tempId, turnId)
    const fresh = useChatStore.getState().openThreads[tempId]
    if (!fresh) return
    stickToBottom.current = true
    appendTurn(tempId, {
      id: uuid(), role: 'user', steps: [], text: newText, citations: [], artifacts: [], status: 'done',
    })
    void stream({
      tempId,
      query: newText,
      agentFqn: fresh.agentFqn,
      threadId: fresh.thread.threadId,
      parentMessageId: fresh.thread.lastAssistantMessageId,
      currentUserName,
    })
  }, [activeThreadTempId, forkAt, appendTurn, stream, currentUserName])

  const handleRegenerateTurn = useCallback((turnId: string) => {
    const tempId = activeThreadTempId
    if (!tempId) return
    const current = useChatStore.getState().openThreads[tempId]
    const idx = current?.turns.findIndex((t) => t.id === turnId) ?? -1
    const userTurn = idx > 0 ? current!.turns[idx - 1] : undefined
    if (!userTurn) return
    forkAt(tempId, turnId)
    const fresh = useChatStore.getState().openThreads[tempId]
    if (!fresh) return
    stickToBottom.current = true
    void stream({
      tempId,
      query: userTurn.text,
      agentFqn: fresh.agentFqn,
      threadId: fresh.thread.threadId,
      parentMessageId: fresh.thread.lastAssistantMessageId,
      currentUserName,
    })
  }, [activeThreadTempId, forkAt, stream, currentUserName])

  const handleSwitchFork = useCallback((forkKey: string) => {
    const tempId = activeThreadTempId
    if (tempId) switchFork(tempId, forkKey)
  }, [activeThreadTempId, switchFork])

  const handleSwitchRootFork = useCallback(() => handleSwitchFork(ROOT_FORK_KEY), [handleSwitchFork])

  // Hoisted out of the turns.map below, where it re-ran a linear scan of threadSummaries for
  // every turn on every render.
  const activeThreadId = activeThread?.threadId
  const threadTitle = activeThreadId
    ? threadSummaries.find((s) => s.thread_id === activeThreadId)?.thread_name
    : undefined

  // Single forward pass instead of a reversed slice+find per turn (which made pairing O(n²)).
  const turnPairing = useMemo(() => {
    const out: (string | undefined)[] = []
    let lastUserText: string | undefined
    for (const t of turns) {
      out.push(t.role === 'assistant' ? lastUserText : undefined)
      if (t.role === 'user') lastUserText = t.text
    }
    return out
  }, [turns])

  return (
    <div className="chat-container">
      <div
        className="message-list"
        ref={listRef}
        onScroll={handleListScroll}
        role="log"
        aria-live="polite"
        aria-atomic="false"
        aria-label="Conversation"
      >
        {turns.length === 0 && (
          <EmptyState
            onSend={sendMessage}
            questions={activeAgentFqn ? sampleQuestions[activeAgentFqn] : undefined}
            userName={currentUserName}
            activeAgentFqn={activeAgentFqn}
          />
        )}
        {activeThread?.forks?.[ROOT_FORK_KEY] && (
          <ForkSwitcher onSwitch={handleSwitchRootFork} />
        )}
        {/* Every callback below is a stable useCallback, and the per-turn ones take the turn id
            rather than closing over it - that's what lets React.memo(ConversationTurn) skip the
            turns that didn't change while one of them streams. */}
        {turns.map((turn, i) => (
          <ConversationTurn
            key={turn.id}
            turn={turn}
            lastUserQuestion={turnPairing[i]}
            threadTitle={threadTitle}
            threadId={activeThreadId}
            ShareButton={ShareButton}
            onRegenerate={turn.role === 'assistant' && !isStreaming ? handleRegenerateTurn : undefined}
            onEditMessage={turn.role === 'user' && !isStreaming ? handleEditMessage : undefined}
            onSwitchFork={activeThread?.forks?.[turn.id] ? handleSwitchFork : undefined}
            onSuggestion={sendMessage}
            onArtifactClick={handleArtifactClick}
            onFeedback={handleFeedback}
            onViewCitations={handleCitationsClick}
            onRefreshThread={activeThreadId ? handleRefreshThread : undefined}
          />
        ))}
      </div>

      <div className="input-row">
        {isStreaming && <StopButton onStop={() => stop(activeThread?.tempId)} />}
        <ChatControls snowflakeToken={snowflakeToken} onOpenPanel={onArtifactOpen} />
        <MessageInput
          onSend={sendMessage}
          disabled={isStreaming || !connected}
          tempId={activeThread?.tempId}
          snowflakeToken={snowflakeToken}
          agentFqn={activeAgentFqn}
        />
      </div>
    </div>
  )
}
