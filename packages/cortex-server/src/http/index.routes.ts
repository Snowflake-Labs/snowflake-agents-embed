// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Hono } from 'hono'
import type { CortexRouteDeps } from './deps.js'
import { registerConfigRoutes } from './config.routes.js'
import { registerTelemetryRoutes } from './telemetry.routes.js'
import { registerStatementsRoutes } from './statements.routes.js'
import { registerFeedbackRoutes } from './feedback.routes.js'
import { registerAgentsRoutes } from './agents.routes.js'
import { registerTitleRoutes } from './title.routes.js'
import { registerThreadRoutes } from './threads.routes.js'
import { registerAgentRunRoutes } from './agent-run.routes.js'
import { registerMcpOAuthRoutes } from './mcp-oauth.routes.js'

export {
  registerConfigRoutes,
  registerTelemetryRoutes,
  registerStatementsRoutes,
  registerFeedbackRoutes,
  registerAgentsRoutes,
  registerTitleRoutes,
  registerThreadRoutes,
  registerAgentRunRoutes,
  registerMcpOAuthRoutes,
}

/**
 * Registers every shared Cortex route on `app`. A host that wants all of them
 * (both existing hosts do) can call this once instead of importing each
 * registerX function individually. A bot-only host with no chat surface may
 * want, say, agent-run and agents but not threads or statements - import those
 * factories directly instead of this aggregate.
 */
export function registerCortexApiRoutes(app: Hono, deps: CortexRouteDeps): void {
  registerConfigRoutes(app, deps)
  registerTelemetryRoutes(app, deps)
  registerStatementsRoutes(app, deps)
  registerFeedbackRoutes(app, deps)
  registerAgentsRoutes(app, deps)
  registerTitleRoutes(app, deps)
  registerThreadRoutes(app, deps)
  registerAgentRunRoutes(app, deps)
  registerMcpOAuthRoutes(app, deps)
}
