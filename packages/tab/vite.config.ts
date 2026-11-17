// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const SECRET_VITE = /^VITE_.*(?:PAT|SECRET|TOKEN|PASSWORD|KEY)/

function assertNoLeakedViteSecrets(mode: string, envDir: string = process.cwd()): void {
  const env = loadEnv(mode, envDir, '')
  const optIn = env.ALLOW_LOCAL_PAT_BUILD === '1'
  const isLocalPat = env.VITE_AUTH_MODE === 'local-pat'
  const leaked = Object.keys(env).filter((key) => SECRET_VITE.test(key) && env[key])
  if (leaked.length && !(isLocalPat && optIn)) {
    throw new Error(
      `Refusing to build with inlinable secret env (${leaked.join(', ')}). ` +
      `Set VITE_AUTH_MODE=local-pat and ALLOW_LOCAL_PAT_BUILD=1 to opt in.`,
    )
  }
  if (mode === 'production' && isLocalPat && !optIn) {
    throw new Error(
      'Refusing a production local-pat build without ALLOW_LOCAL_PAT_BUILD=1.',
    )
  }
}

export default defineConfig(({ mode }) => {
  assertNoLeakedViteSecrets(mode)
  return {
    plugins: [react()],
    build: {
      // Not load-bearing on this side, but one asset-inlining mechanism keeps the shared
      // chat-core stylesheet host-agnostic.
      assetsInlineLimit: (filePath) =>
        /\.(ttf|woff2?)$/i.test(filePath) ? true : undefined,
    },
    server: {
      port: 5173,
      proxy: {
        '/api': 'http://localhost:3000',
      },
    },
    test: {
      environment: 'happy-dom',
      setupFiles: ['src/test-setup.ts'],
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
    },
  }
})
