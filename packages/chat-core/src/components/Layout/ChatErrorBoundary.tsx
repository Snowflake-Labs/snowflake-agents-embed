// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Last-resort guard around the whole embedded chat. Without this, a render
 * error anywhere below AppShell unmounts the entire widget inside the host
 * page (Teams tab iframe) with no way for the end user to
 * recover short of a full page reload.
 */
export class ChatErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Agents Embed chat crashed:', error, info.componentStack)
  }

  private reset = () => this.setState({ error: null })

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, padding: 24, textAlign: 'center' }}>
        <p>Something went wrong loading the chat.</p>
        <button onClick={this.reset}>Try again</button>
      </div>
    )
  }
}
