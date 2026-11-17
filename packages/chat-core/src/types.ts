// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { MapSpec } from './lib/mapSpec.js'

export type VegaLiteSpec = Record<string, unknown>
export type { MapSpec }

export interface ThinkingStep {
  id: string
  toolType: string
  status: 'running' | 'done' | 'error'
  label: string
  sql?: string
  /** Narration from a response.tool_result.status event, e.g. "Running Sales_Analyst". */
  statusMessage?: string
  queryId?: string
  verifiedQueryUsed?: boolean
  semanticModelName?: string
  /** Present only for a schedule_snowflake_task tool_use - see lib/automationStep.ts. */
  automation?: AutomationStepInfo
}

export interface AutomationStepInfo {
  action?: string
  schedule?: string
  target?: string
}

export interface Citation {
  /** Display number. 1-based; renumbered sequentially across the sorted set, not Cortex's raw annotation_index. */
  index: number
  docTitle?: string
  /** Only set when docId parses as an http(s) URL - Cortex Search doc_ids aren't always links. */
  url?: string
  /** Raw Cortex Search doc_id - kept even when it isn't a usable URL, as a fallback heading. */
  docId?: string
  /** Source snippet Cortex quoted from the document. */
  text?: string
  /** Cortex's per-citation identity - the dedupe key, since annotation_index resets per content block. */
  searchResultId?: string
  contentIndex?: number
}

export interface ColumnDef {
  name: string
  type: string
}

export type ChartArtifact = { id: string; type: 'chart'; spec: VegaLiteSpec; toolUseId?: string }
export type TableArtifact = {
  id: string
  type: 'table'
  rowType: ColumnDef[]
  data: unknown[][]
  queryId?: string
  numRows?: number
  title?: string
}
export type MapArtifact = { id: string; type: 'map'; spec: MapSpec; toolUseId?: string }
export type Artifact = ChartArtifact | TableArtifact | MapArtifact

/**
 * ask_user_question / permission_decision live protocol is unconfirmed (Phase 1 probe found no
 * live evidence for either). This carries whatever we can extract from the tool_use input so the
 * fallback UI can render a prompt and, on submit, send the answer as a plain new user turn.
 */
export interface PendingQuestion {
  toolUseId: string
  toolType: string
  prompt: string
  options?: string[]
}

export interface ConversationTurn {
  id: string
  role: 'user' | 'assistant'
  /**
   * Cortex message id, once known. Absent while streaming - the id arrives on a metadata
   * event partway through - and absent entirely if the stream fails before that event.
   * Kept per turn rather than read from ThreadState because a host that saves an *older*
   * answer elsewhere (e.g. to an external record) needs that answer's id, not the newest
   * one in the thread.
   */
  messageId?: number
  steps: ThinkingStep[]
  text: string
  citations: Citation[]
  artifacts: Artifact[]
  status: 'streaming' | 'done' | 'error'
  errorCode?: string
  errorMessage?: string
  /** Set when a reload caught this turn mid-stream and downgraded it to 'error' - drives a
   * "Refresh this thread" action instead of the plain "Try again" retry. */
  interrupted?: boolean
  /** Only ever seen on Cortex error response bodies during the Phase 1 probe — not confirmed on the happy path. */
  requestId?: string
  suggestions?: string[]
  /** Narration from response.thinking(.delta) — undefined when nothing to show. */
  thinking?: string
  /**
   * Live progress narration from the most recent response.status event ("Planning the next
   * steps", "Running Sales_Analyst") — see lib/statusLabel.ts. Only meaningful while the
   * turn streams; cleared once it reaches 'done' or 'error', since it describes work in flight.
   */
  statusLabel?: string
  sequenceNumber?: number
  pendingQuestion?: PendingQuestion
  /** response.warning events (e.g. MCP-auth-required, TOOL_NOT_ACCESSIBLE). Stored on the
   * turn and shown in Agent details — never inlined in the thread. */
  warnings?: { code?: string; message?: string }[]
}

export interface ThreadState {
  threadId?: number
  lastAssistantMessageId?: number
}

export interface FileAttachment {
  name: string
  mimeType: string
  /** Raw file text - images aren't supported since Cortex agent:run has no image content-part. */
  data: string
  sizeBytes: number
}
