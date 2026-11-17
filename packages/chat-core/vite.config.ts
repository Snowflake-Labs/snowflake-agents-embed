// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// chat-core has no build step of its own — it is consumed as TypeScript source by
// packages/tab via workspace `exports` subpaths. This config exists
// only to give vitest a jsx transform and a browser-like DOM for component tests.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['src/test-setup.ts'],
  },
})
