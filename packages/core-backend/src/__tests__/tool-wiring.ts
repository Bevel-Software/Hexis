/**
 * The pieces the composition root wires from module internals, for a suite
 * that builds a tool surface the way `core/create-core-server.ts` does: the
 * handler factory and context resolver, the tool-auth middleware, the two
 * registrars that take their dependencies by hand, the session sink, the
 * routine write policy, the access resolver, the version-control hooks, the
 * manual auth middleware and the auth cookie reader, and the MCP routes and service.
 *
 * A module's entry holds its contracts, and a suite asserts through entries.
 * These are not contracts: they are what the root composes, so a suite that
 * needs them reaches them here, the one root fixture that imports past the
 * entries, as the root itself does. A suite that imports one of these files
 * directly is a second wiring that drifts from the root's.
 */
export { createToolHandlerFactory } from '../modules/tool-helpers/tool-handler.js';
export { createToolContextResolver } from '../modules/tool-helpers/tool-context.js';
export { createToolAuthMiddleware } from '../modules/tool-auth/tool-auth.middleware.js';
export { InternalTokenService } from '../modules/tool-auth/internal-token.service.js';
export { registerWorkspaceTools } from '../modules/workspace/workspace.tools.js';
export { registerVersionControlTools } from '../modules/version-control/agent-tools/version-control.tools.js';
export { registerChangeRequestReadTools } from '../modules/version-control/agent-tools/change-request-read.tools.js';
export { registerEmbedTools } from '../modules/embed/embed.tools.js';
export { UuidSessionSink } from '../modules/workspace/session-sink.js';
export { RoutineWritePolicyService } from '../modules/workspace/routine-write-policy.js';
export { AccessControlService, loadActiveGroups } from '../modules/access/access-control.service.js';
export { VersionControlHooks, type AgentOperationContext } from '../modules/version-control/version-control-hooks.js';
export { createManualAuthMiddleware } from '../modules/tool-auth/tool-auth.middleware.js';
export { readAuthCookie } from '../modules/auth/auth.middleware.js';
export type { ToolBranchPort } from '../modules/tool-helpers/tool-handler.js';
export { createMcpRoutes } from '../modules/mcp/mcp.routes.js';
export { McpService } from '../modules/mcp/mcp.service.js';
