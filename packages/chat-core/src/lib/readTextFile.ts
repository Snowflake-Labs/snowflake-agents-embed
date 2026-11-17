// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { FileAttachment } from '../types.js'

const MAX_TEXT_BYTES = 100_000

const TEXT_MIME_TYPES = new Set(['text/plain', 'text/csv', 'application/json', 'text/markdown'])
const TEXT_EXTENSIONS = /\.(csv|txt|json|md)$/i

export function isTextAttachment(file: File): boolean {
  return TEXT_MIME_TYPES.has(file.type) || TEXT_EXTENSIONS.test(file.name)
}

export function readTextFile(file: File): Promise<FileAttachment> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_TEXT_BYTES) {
      reject(new Error(`File exceeds ${MAX_TEXT_BYTES} byte limit`))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.onload = () => {
      const text = reader.result as string
      resolve({
        name: file.name,
        mimeType: file.type || 'text/plain',
        data: text,
        sizeBytes: file.size,
      })
    }
    reader.readAsText(file)
  })
}
