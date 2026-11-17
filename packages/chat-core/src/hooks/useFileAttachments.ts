// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useCallback } from 'react'
import type { FileAttachment } from '../types.js'
import { isTextAttachment, readTextFile } from '../lib/readTextFile.js'

/**
 * Shared by the click-to-upload input and drag-drop paths so file validation only
 * lives in one place.
 */
export function useFileAttachments(onAdd: (attachment: FileAttachment) => void) {
  return useCallback(async (files: FileList | File[] | null | undefined) => {
    if (!files) return
    for (const file of Array.from(files)) {
      try {
        if (isTextAttachment(file)) {
          onAdd(await readTextFile(file))
        }
      } catch {
        // silently skip unreadable or oversized files
      }
    }
  }, [onAdd])
}
