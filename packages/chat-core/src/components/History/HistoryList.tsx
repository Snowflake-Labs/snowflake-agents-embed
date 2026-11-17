// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, useMemo } from 'react'
import { listThreads } from '../../api/threads.js'
import { useChatStore } from '../../store/chatStore.js'
import { useOpenThread } from '../../hooks/useOpenThread.js'
import { HistoryItem } from './HistoryItem.js'
import { getAllThreadAgents } from '../../lib/threadAgents.js'
import { groupByDate, type DateGroup } from '../../lib/dateGroups.js'
import { getAllThreadFlags, setThreadPinned, setThreadArchived } from '../../lib/threadFlags.js'
import { classifyError, type ClassifiedError } from '../../lib/classifyError.js'

const PAGE_SIZE = 20

interface Props {
  snowflakeToken: string
  /** Host session has landed. Not the same as holding a token - see ChatContainer. */
  connected: boolean
  /** Collapsed mid/wide rail: hide titles that would wrap unreadably. Narrow Drawer
   * leaves this unset so history stays visible. List stays mounted either way. */
  hidden?: boolean
  /** Also list threads with no local agent mapping (created in another browser/client). Only
   * safe when the server scopes the list to the signed-in user. */
  showUnmapped?: boolean
}

export function HistoryList({ snowflakeToken, connected, hidden, showUnmapped }: Props) {
  const threadSummaries = useChatStore((s) => s.threadSummaries)
  const setThreadSummaries = useChatStore((s) => s.setThreadSummaries)
  const activeThreadTempId = useChatStore((s) => s.activeThreadTempId)
  const activeThreadId = useChatStore((s) => (
    s.activeThreadTempId ? s.openThreads[s.activeThreadTempId]?.threadId : undefined
  ))
  const activeAgentFqn = useChatStore((s) => s.activeAgentFqn)
  const openThread = useOpenThread(snowflakeToken)
  const [listError, setListError] = useState<ClassifiedError | null>(null)
  const [flags, setFlags] = useState(() => getAllThreadFlags())
  const [agents, setAgents] = useState(() => getAllThreadAgents())
  const [showArchived, setShowArchived] = useState(false)
  const [cursor, setCursor] = useState<string | undefined>()
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    if (!connected) return
    listThreads(snowflakeToken, { pageSize: PAGE_SIZE })
      .then(({ threads, after }) => {
        setListError(null)
        setThreadSummaries(threads)
        setCursor(after)
      })
      .catch((err: unknown) => setListError(classifyError(err, 'Failed to load history')))
  }, [connected, snowflakeToken, setThreadSummaries])

  function loadMore() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    listThreads(snowflakeToken, { pageSize: PAGE_SIZE, after: cursor })
      .then(({ threads, after }) => {
        setThreadSummaries([...useChatStore.getState().threadSummaries, ...threads])
        setCursor(after)
      })
      .catch((err: unknown) => setListError(classifyError(err, 'Failed to load history')))
      .finally(() => setLoadingMore(false))
  }

  useEffect(() => {
    setAgents(getAllThreadAgents())
  }, [threadSummaries])

  function togglePin(threadId: number) {
    const next = !flags[String(threadId)]?.pinned
    setThreadPinned(threadId, next)
    setFlags((prev) => ({ ...prev, [String(threadId)]: { ...prev[String(threadId)], pinned: next } }))
  }

  function toggleArchive(threadId: number) {
    const next = !flags[String(threadId)]?.archived
    setThreadArchived(threadId, next)
    setFlags((prev) => ({ ...prev, [String(threadId)]: { ...prev[String(threadId)], archived: next } }))
  }

  const { pagedGroups, empty } = useMemo(() => {
    const namedThreads = threadSummaries.filter((s) =>
      (s.thread_name ?? '').trim().length > 0 &&
      (agents[String(s.thread_id)] === activeAgentFqn ||
        (showUnmapped === true && agents[String(s.thread_id)] === undefined))
    )
    const visibleThreads = namedThreads.filter((s) => showArchived || !flags[String(s.thread_id)]?.archived)
    const pinned = visibleThreads.filter((s) => flags[String(s.thread_id)]?.pinned)
    const unpinned = visibleThreads.filter((s) => !flags[String(s.thread_id)]?.pinned)

    const groups: DateGroup[] = pinned.length > 0
      ? [{ label: 'Pinned', items: pinned }, ...groupByDate(unpinned)]
      : groupByDate(unpinned)

    return {
      pagedGroups: groups,
      empty: visibleThreads.length === 0,
    }
  }, [threadSummaries, agents, flags, showArchived, activeAgentFqn, showUnmapped])

  return (
    <div className="history-list" hidden={hidden}>
      <div className="history-header">
        <span className="history-title">History</span>
        <label className="history-show-archived">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>
      {listError && (
        <div className="history-error">
          {listError.message}
          <details>
            <summary>Details</summary>
            {listError.raw}
          </details>
        </div>
      )}
      {!listError && empty && (
        <div className="history-empty">No previous conversations</div>
      )}
      {pagedGroups.map((group) => (
        <div key={group.label} className="history-group">
          <div className="history-group-label">{group.label}</div>
          {group.items.map((s) => {
            const isActive = s.thread_id === activeThreadId && Boolean(activeThreadTempId)
            return (
              <HistoryItem
                key={s.thread_id}
                summary={s}
                active={isActive}
                snowflakeToken={snowflakeToken}
                onOpen={openThread}
                pinned={!!flags[String(s.thread_id)]?.pinned}
                archived={!!flags[String(s.thread_id)]?.archived}
                onTogglePin={() => togglePin(s.thread_id)}
                onToggleArchive={() => toggleArchive(s.thread_id)}
              />
            )
          })}
        </div>
      ))}
      {cursor && (
        <button className="history-show-more" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  )
}
