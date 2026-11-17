// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { firstNameOf } from '../../lib/firstName.js'

interface Props {
  onSend: (text: string) => void
  // Per-agent starters from the agent spec. Missing / empty means greeting only —
  // no invented fallback prompts.
  questions?: string[]
  // The signed-in user's display name, if the host has one. Greeting degrades
  // gracefully to a name-less form when absent.
  userName?: string
  // Keys the starter list so switching agents remounts it - two agents can share a
  // question string, and without this React reuses the DOM node instead of re-animating.
  activeAgentFqn?: string
}

function getTimeOfDayGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function QuestionIcon() {
  return (
    <svg className="starter-item-icon" width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 3.5C2 2.67 2.67 2 3.5 2h9c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H7l-3 2.5V11H3.5C2.67 11 2 10.33 2 9.5v-6Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function EmptyState({ onSend, questions, userName, activeAgentFqn }: Props) {
  // Greeting stays on a first-name basis whatever shape the host's name arrived in.
  const firstName = firstNameOf(userName)
  const items = questions && questions.length > 0 ? questions : []
  return (
    <div className="empty-state">
      <div className="empty-state-greeting">
        <p className="empty-state-greeting-line">{getTimeOfDayGreeting()}{firstName ? `, ${firstName}` : ''}</p>
        <p className="empty-state-headline">What insights can I help with?</p>
      </div>
      {items.length > 0 && (
        <ul className="starter-list" key={activeAgentFqn}>
          {items.map((question, index) => (
            <li key={question} style={{ '--starter-index': index } as React.CSSProperties}>
              <button
                className="starter-item"
                onClick={() => onSend(question)}
              >
                <QuestionIcon />
                <span>{question}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
