// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// vitest setup file
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { setHostAdapter } from './host/hostAdapter.js'

// Every api/* call goes through the active HostAdapter; without a default, any test that
// exercises fetchAgents/streamAgentRun/describeThread etc. without its own explicit
// setHostAdapter() would throw "HostAdapter not initialized" instead of failing on its
// actual assertion. Tests that care about host-specific header/URL behavior (agentRun.test.ts,
// threads.test.ts) still set their own adapter explicitly.
setHostAdapter({
  baseUrl: () => '',
  headers: (token, extra) => ({ 'X-User-Access-Token': token ?? '', ...extra }),
})

// React Testing Library only auto-cleans when vitest runs with `globals: true`, which this
// project does not. Without it a mounted hook keeps its document-level listeners for the
// rest of the file, so a test asserting "nothing was posted" can be answered by a previous
// test's listener.
afterEach(cleanup)

// React only treats `act()` as an act scope when this flag is set, and RTL sets it only
// under `globals: true`. Without it, a test that drives a store update through act() still
// warns "the current testing environment is not configured to support act(...)" and the
// resulting effects are not flushed before the assertion.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
