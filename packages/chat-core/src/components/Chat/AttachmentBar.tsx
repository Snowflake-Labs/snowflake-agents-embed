// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { FileAttachment } from '../../types.js'
import { XIcon } from './composer/icons.js'

interface Props {
  attachments: FileAttachment[]
  onRemove: (index: number) => void
}

/**
 * Chip-rendering tail only - the upload trigger moved into composer/ComposerMenu.tsx's "+"
 * menu. Kept as its own component since attachment chips render in the same spot regardless
 * of which composer path (textarea or richComposer) is active.
 */
export function AttachmentBar({ attachments, onRemove }: Props) {
  if (attachments.length === 0) return null

  return (
    <div className="attachment-bar">
      {attachments.map((a, i) => (
        <span key={i} className="attachment-chip">
          <span className="attachment-chip-name">{a.name}</span>
          <button
            className="attachment-chip-remove"
            onClick={() => onRemove(i)}
            title={`Remove ${a.name}`}
          ><XIcon /></button>
        </span>
      ))}
    </div>
  )
}

