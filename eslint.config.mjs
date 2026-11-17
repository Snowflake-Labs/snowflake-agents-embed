// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packages/{server,tab,teams-edge,chat-core,cortex-server}/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/test-setup.ts', '**/test/**'],
    languageOptions: {
      parserOptions: {
        project: [
          'packages/{server,tab,chat-core,cortex-server}/tsconfig.json',
          'packages/teams-edge/tsconfig.json',
          'packages/teams-edge/tsconfig.node.json',
          'packages/teams-edge/tsconfig.workers.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
]
