// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState, memo } from 'react'
import type { ThreadSummary } from '../../api/threads.js'
import { renameThread, deleteThread } from '../../api/threads.js'
import { useChatStore } from '../../store/chatStore.js'
import { removeThreadAgent } from '../../lib/threadAgents.js'
import { PinIcon, ArchiveIcon, PencilIcon, TrashIcon } from '../Chat/composer/icons.js'

interface Props {
  summary: ThreadSummary
  active: boolean
  snowflakeToken: string
  onOpen: (threadId: number) => void
  pinned?: boolean
  archived?: boolean
  onTogglePin?: () => void
  onToggleArchive?: () => void
}

function HistoryItemImpl({
  summary, active, snowflakeToken, onOpen, pinned, archived, onTogglePin, onToggleArchive,
}: Props) {
  const [renaming, setRenaming] = useState(false)
  const [nameValue, setNameValue] = useState(summary.thread_name ?? '')
  const updateSummaryName = useChatStore((s) => s.updateSummaryName)
  const removeSummary = useChatStore((s) => s.removeSummary)

  async function handleRename() {
    const trimmed = nameValue.trim()
    if (!trimmed) { setRenaming(false); return }
    try {
      await renameThread(snowflakeToken, summary.thread_id, trimmed)
      updateSummaryName(summary.thread_id, trimmed)
    } catch { /* ignore */ }
    setRenaming(false)
  }

  async function handleDelete() {
    try {
      await deleteThread(snowflakeToken, summary.thread_id)
      removeSummary(summary.thread_id)
      removeThreadAgent(summary.thread_id)
    } catch { /* ignore */ }
  }

  return (
    <div className={`history-item${active ? ' history-item--active' : ''}${archived ? ' history-item--archived' : ''}`}>
      {renaming ? (
        <input
          className="history-rename-input"
          value={nameValue}
          autoFocus
          onChange={(e) => setNameValue(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleRename()
            if (e.key === 'Escape') setRenaming(false)
          }}
        />
      ) : (
        <button
          className="history-item-title"
          onClick={() => onOpen(summary.thread_id)}
          title={summary.thread_name?.trim() || 'New Chat'}
        >
          {pinned && <span className="history-pin-badge" aria-hidden><PinIcon /></span>}
          {summary.thread_name?.trim() || 'New Chat'}
          {summary.source === 'cowork' && (
            <span className="history-source-badge">CoWork</span>
          )}
        </button>
      )}
      <div className="history-item-actions">
        {onTogglePin && (
          <button
            className="history-action-btn"
            onClick={onTogglePin}
            aria-pressed={pinned}
            aria-label={pinned ? 'Unpin' : 'Pin'}
            title={pinned ? 'Unpin' : 'Pin'}
          ><PinIcon /></button>
        )}
        {onToggleArchive && (
          <button
            className="history-action-btn"
            onClick={onToggleArchive}
            aria-pressed={archived}
            aria-label={archived ? 'Unarchive' : 'Archive'}
            title={archived ? 'Unarchive' : 'Archive'}
          ><ArchiveIcon /></button>
        )}
        <button
          className="history-action-btn"
          onClick={() => { setNameValue(summary.thread_name ?? ''); setRenaming(true) }}
          title="Rename"
        ><PencilIcon /></button>
        <button
          className="history-action-btn history-action-btn--danger"
          onClick={handleDelete}
          title="Delete"
        ><TrashIcon /></button>
      </div>
    </div>
  )
}

export const HistoryItem = memo(HistoryItemImpl)
