/**
 * @bevel-software/core-backend — the open-source core of the Bevel platform:
 * git-backed knowledge workspace, workflow (branches / change requests /
 * locks / SSE), skills, tool manuals + registry + auth, secrets vault, access
 * control, diff/backup ledger, code-mode and the remote MCP surface.
 *
 * Composition entry points:
 *   - `new CoreConfig()`                     — env-driven core configuration
 *   - `createCoreServices(config, ports)`    — construct every core service
 *   - `createCoreServer(core, ext, opts)`    — the Express app (fixed mount order)
 *
 * Importing this package ALSO applies the global Express `Request`
 * augmentation (`req.userId` / `req.userEmail` / token payloads) — the
 * middleware modules re-exported below carry the `declare global` blocks, so
 * consumers get the augmented types without a side-effect import of their own.
 *
 * Finer-grained internals are available via the `./modules/*` subpath exports.
 */

export { CoreConfig } from './core-config.js';
export { createCoreServices, type CoreServices } from './core/create-core-services.js';
export {
  createCoreServer,
  type ServerExtensions,
  type ToolSurfaceCtx,
} from './core/create-core-server.js';
export { noopRecoveryAgent, type CorePorts } from './core/core-ports.js';

// Packaged assets (migrations/, kb-template/) + the migration runners.
export { coreMigrationsDir, defaultKbTemplateDir } from './assets.js';
export {
  runCoreMigrations,
  runEnterpriseMigrations,
} from './modules/database/migrate.js';
export { getDb, type Database } from './modules/database/connection.js';

// Build identity surfaced by GET /api/health.
export { GIT_SHA, resolveGitSha } from './version.js';

// Express `Request` augmentation carriers (userId/userEmail — auth.middleware;
// token payloads — tool-auth + external-api-key interface). Re-exported by
// VALUE/type so the `declare global` blocks land in this package's public
// declaration graph.
export { createAuthMiddleware, AUTH_COOKIE_NAME } from './modules/auth/auth.middleware.js';
export {
  createToolAuthMiddleware,
  createManualAuthMiddleware,
} from './modules/tool-auth/tool-auth.middleware.js';
export type {
  IExternalApiKeyService,
  ExternalApiKeySummary,
} from './modules/tool-auth/external-api-key.interface.js';

// Key port/seam types an overlay implements.
export type { ISessionSink } from './modules/workspace/session-sink.js';
export type {
  ISystemNoticeSink,
  RecoveryAgentRunner,
} from './modules/workflow/pending-commits.worker.js';
export type { ILlmUsageMeter } from './modules/tool-auth/llm-usage-meter.js';
export type { AuthProviderPlugin } from './modules/auth/auth.routes.js';
export type { IErasureParticipant } from './modules/auth/account-erasure.service.js';
export {
  WorkflowHooks,
  type CommitValidationHook,
  type CommitValidationContext,
  type PreWriteHook,
  type PreWriteContext,
} from './modules/workflow/workflow-hooks.js';
