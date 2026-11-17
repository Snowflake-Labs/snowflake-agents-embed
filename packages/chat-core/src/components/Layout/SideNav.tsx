// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useChatStore } from '../../store/chatStore.js'
import { HistoryList } from '../History/HistoryList.js'
import { ChatBubbleIcon, AgentIcon, SearchIcon, PlusIcon, PanelCollapseIcon } from '../Chat/composer/icons.js'
import { firstNameOf } from '../../lib/firstName.js'

interface Props {
  snowflakeToken: string
  /** Host session has landed. Not the same as holding a token - see ChatContainer. */
  connected: boolean
  onNewChat: () => void
  userName?: string
  showUnmappedHistory?: boolean
  /** Present only at mid/wide, where collapse is coherent - absent inside the narrow Drawer,
   * which should never render the toggle. */
  collapsed?: boolean
  onToggleCollapsed?: () => void
}

export function SideNav({ snowflakeToken, connected, onNewChat, userName, showUnmappedHistory, collapsed, onToggleCollapsed }: Props) {
  const activeView = useChatStore((s) => s.activeView)
  const setActiveView = useChatStore((s) => s.setActiveView)

  return (
    <>
      <div className="sidebar-top">
        <button className="new-chat-btn" onClick={onNewChat} aria-label="New chat">
          <PlusIcon />
          <span className="side-nav-item-label">New chat</span>
        </button>
        {onToggleCollapsed && (
          <button
            className="sidebar-collapse-btn"
            onClick={onToggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          ><PanelCollapseIcon /></button>
        )}
      </div>

      <nav className="side-nav">
        <button
          className={`side-nav-item${activeView === 'chat' ? ' side-nav-item--active' : ''}`}
          onClick={() => setActiveView('chat')}
        >
          <ChatBubbleIcon /> <span className="side-nav-item-label">Chat</span>
        </button>
        <button
          className={`side-nav-item${activeView === 'agents' ? ' side-nav-item--active' : ''}`}
          onClick={() => setActiveView('agents')}
        >
          <AgentIcon /> <span className="side-nav-item-label">Agents</span>
        </button>
        <button
          className={`side-nav-item${activeView === 'search' ? ' side-nav-item--active' : ''}`}
          onClick={() => setActiveView('search')}
        >
          <SearchIcon /> <span className="side-nav-item-label">Search</span>
        </button>
      </nav>

      <HistoryList snowflakeToken={snowflakeToken} connected={connected} hidden={collapsed === true} showUnmapped={showUnmappedHistory} />

      {userName && (
        <div className="sidebar-user">
          <span className="sidebar-user-avatar" aria-hidden="true">{firstNameOf(userName)?.[0]?.toUpperCase() ?? '?'}</span>
          <span className="side-nav-item-label">{userName}</span>
        </div>
      )}
    </>
  )
}
