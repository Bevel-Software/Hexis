import express from 'express';
import cors from 'cors';
import path from 'node:path';
import type { Router, RequestHandler } from 'express';
import { createAuthRoutes } from '../modules/auth/auth.routes.js';
import { createWorkspaceRoutes } from '../modules/workspace/workspace.routes.js';
import { createDiffRoutes } from '../modules/diff/diff.routes.js';
import { createWorkflowRoutes } from '../modules/workflow/workflow.routes.js';
import { createEventsRoutes } from '../modules/workflow/events.routes.js';
import { createAccessRoutes } from '../modules/access/access.routes.js';
import { createMcpRoutes } from '../modules/mcp/mcp.routes.js';
import { createOAuthConsentRoutes } from '../modules/mcp/oauth/oauth-consent.routes.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { createManualRoutes } from '../modules/tool-registry/manual.routes.js';
import {
  createToolManualsAgentRoutes,
  createToolManualsBrowserRoutes,
  registerToolManualsTools,
} from '../modules/tool-manuals/index.js';
import { registerWorkflowTools } from '../modules/workflow/agent-tools/workflow.tools.js';
import { registerWorkspaceTools } from '../modules/workspace/workspace.tools.js';
import { RECOVERY_BOT_EMAIL } from '../modules/workflow/recovery-bot.js';
import { registerSkillsTools, createSkillsRoutes } from '../modules/skills/index.js';
import { createGroupsRoutes } from '../modules/groups/index.js';
import type { SessionOntologyGate } from '../modules/workspace/session-ontology.gate.js';
import {
  createSecretsVaultRoutes,
  createSecretsVaultPublicRoutes,
} from '../modules/secrets-vault/index.js';
import { createAdminAccessRoutes } from '../modules/admin/admin-access.routes.js';
import { GIT_SHA } from '../version.js';
import type { CoreServices } from './create-core-services.js';

type ExpressApp = ReturnType<typeof express>;

/**
 * The context handed to {@link ServerExtensions.tools}: everything an overlay
 * needs to register its own tool defs + endpoint routes on the unified tool
 * surface, exactly like the core modules do.
 */
export interface ToolSurfaceCtx {
  registry: CoreServices['toolRegistry'];
  router: Router;
  toolAuth: RequestHandler;
  toolHandler: CoreServices['toolHandlerFactory'];
  /** Shared ontology-session boundary gate config (file tools + graph tools). */
  sessionOntologyGate: SessionOntologyGate;
  core: CoreServices;
}

/**
 * The hook points an overlay (the enterprise app) uses to add its surfaces to
 * the core server. Each hook maps to a fixed slot in the LOAD-BEARING mount
 * order encoded in {@link createCoreServer} — the order comments there explain
 * why each slot sits where it does (Express 5 fires outer middleware before
 * route matching, so pre-JWT surfaces MUST mount before the JWT `/api` mounts).
 */
export interface ServerExtensions {
  /**
   * Request paths the global 10 MB JSON body parser must skip because the
   * overlay's own router installs a larger parser for them (body-parser
   * ignores a second parse once the first has run — see the comment at the
   * parser below).
   */
  jsonParserExemptPaths?: string[];
  /**
   * Boot-time side effects that belong to the server lifecycle (startup
   * reconciles, periodic sweeps). Runs after health/cors/json are installed,
   * before any routes mount.
   */
  onBoot?(core: CoreServices): Promise<void> | void;
  /** Un-authed overlay surfaces (e.g. OAuth callbacks hit by provider redirects). */
  preAuth?(app: ExpressApp, core: CoreServices): void;
  /**
   * Overlay tool registrations on the unified tool surface. Runs after the
   * core registrations and BEFORE the manual routes mount, preserving the
   * "manual snapshot stays complete" invariant.
   */
  tools?(ctx: ToolSurfaceCtx): void;
  /**
   * Non-JWT overlay surfaces that historically mount AFTER the tools router
   * but before the JWT-protected `/api` routes (LLM proxy, embed, upload).
   * A separate phase from `preAuth` purely to preserve today's exact order.
   */
  postTools?(app: ExpressApp, core: CoreServices): void;
  /** JWT-protected overlay routes; mounted after every core authed route. */
  authed?(app: ExpressApp, core: CoreServices): void;
}

export async function createCoreServer(
  core: CoreServices,
  ext: ServerExtensions = {},
  opts: { staticDir?: string } = {},
): Promise<ExpressApp> {
  const app = express();

  // `credentials: true` so EventSource (`withCredentials: true`) can carry
  // the `bevel_token` cookie set at login — the only auth path the
  // EventSource API supports. `origin: true` reflects the request origin
  // back in `Access-Control-Allow-Origin`, which the spec requires when
  // credentials are in play (the wildcard `*` is refused alongside
  // credentials). Cookie itself is `SameSite=Lax`, so a hostile cross-site
  // page still can't read events on the user's behalf.
  //
  // `exposedHeaders` lets a BROWSER-based MCP client (e.g. MCP Inspector) read
  // the Streamable-HTTP session header off the `initialize` response — custom
  // response headers are hidden from browser JS unless exposed, so without this
  // the client can't send `Mcp-Session-Id` back and every follow-up 400s with
  // "session id does not match any active session". `WWW-Authenticate` is
  // exposed so a browser client can read the 401 challenge and start the OAuth
  // discovery flow. (Native clients like Claude Code aren't subject to CORS.)
  app.use(
    cors({
      origin: true,
      credentials: true,
      exposedHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version', 'WWW-Authenticate'],
    }),
  );
  // Global JSON body parser. Some overlay routes carry a whole document dump
  // (e.g. the onboarding import), so their routers install their own larger
  // parser — skip the global one for those paths (body-parser ignores a second
  // parse once the first has run, so without this the 10 MB global limit would
  // shadow the route's larger limit and 413 a large-but-valid upload before it
  // ever reaches the route).
  const jsonExemptPaths = new Set(ext.jsonParserExemptPaths ?? []);
  const globalJson = express.json({ limit: '10mb' });
  app.use((req, res, next) => {
    if (jsonExemptPaths.has(req.path)) return next();
    return globalJson(req, res, next);
  });

  // Health check. `sha` is the git commit this build was produced from
  // (see version.ts) so the deploy pipeline can confirm a staging/production
  // rollout matches the merged commit before smoke-testing it.
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', sha: GIT_SHA, timestamp: Date.now() });
  });

  // Overlay boot-time side effects (startup reconciles, periodic sweeps).
  await ext.onBoot?.(core);

  // Auth routes (unprotected — login endpoint must be accessible)
  app.use(
    '/api',
    createAuthRoutes(
      core.authService,
      core.authMiddleware,
      core.authProviders,
      core.config.loginPasswordEnabled,
    ),
  );

  // MCP routes must mount BEFORE every `app.use('/api', authMiddleware, …)`
  // below: Express 5 fires the outer JWT middleware before deciding whether
  // its router has a matching route, so a request to `POST /api/mcp` carrying
  // a connection-key (non-JWT) bearer would otherwise be 401'd by the first
  // protected mount before this router ever saw it.
  app.use('/api', createMcpRoutes(
    core.mcpService,
    core.externalApiKeyService,
    core.mcpAuthMiddleware,
    core.authMiddleware,
    core.usageMeter,
  ));

  // MCP OAuth 2.1 authorization server: /authorize, /token, /register,
  // /revoke + the /.well-known metadata documents (the SDK requires an
  // app-root mount for those paths). Un-authed by design — these endpoints
  // are hit by MCP clients with no credentials yet and by bare browser
  // navigations; the user attaches to the flow at the JWT/cookie-authed
  // consent routes below. Must sit before the prod SPA catch-all or the
  // .well-known documents would be swallowed by index.html.
  app.use(mcpAuthRouter({
    provider: core.mcpOAuthProvider,
    issuerUrl: new URL(core.config.publicBackendUrl),
    resourceServerUrl: new URL('/api/mcp', core.config.publicBackendUrl),
    scopesSupported: ['mcp'],
    resourceName: 'Bevel MCP',
  }));

  // Un-authed overlay surfaces (e.g. connector OAuth callbacks hit by a
  // provider's browser redirect with no Authorization header).
  ext.preAuth?.(app, core);

  // Secrets Vault OAuth callback — also hit by a provider browser redirect with
  // no Authorization header, so it mounts UN-AUTHED here, recovering the caller
  // from the signed `state`. The authed CRUD/start routes mount later.
  const secretsVaultRoutesDeps = {
    secretsVault: core.secretsVaultService,
    toolManualService: core.toolManualService,
    accessControl: core.accessControl,
    stateSecret: core.config.jwtSecret,
    publicBackendUrl: core.config.publicBackendUrl,
    publicFrontendUrl: core.config.publicFrontendUrl,
  };
  app.use('/api', createSecretsVaultPublicRoutes(secretsVaultRoutesDeps));

  // Unified tool surface — the ONE catalog, served as two UTCP manuals + each
  // tool's module-hosted endpoint, all behind the shared `toolAuth` (connection
  // key OR internal token). Each module registers its tool defs + hosts its
  // routes on this one router. Mount BEFORE the JWT `/api` mounts — connection-
  // key / internal-token bearers would be 401'd by the outer JWT middleware
  // otherwise. Manuals are added LAST so they snapshot the full catalog:
  // core registrations first, then the overlay's (`ext.tools`), then the
  // manual routes.
  const toolsRouter = express.Router();
  const ta = core.toolAuthMiddleware;
  const th = core.toolHandlerFactory;
  // Shared ontology-session boundary gate config, consumed by every tool
  // surface that touches the KB (file tools + graph tools). The gate's
  // blocking decision runs through the workflow hooks: core registers none
  // (tracking only); the enterprise root registers the ontology block on
  // `workflowService.hooks` before this server is built.
  const sessionOntologyGate = {
    service: core.sessionOntologyService,
    enabled: core.config.ontologySessionBlock,
    kbDirName: core.config.kbDirName,
    recoveryBotEmail: RECOVERY_BOT_EMAIL,
    hooks: core.workflowService.hooks,
  };
  registerWorkflowTools(core.toolRegistry, toolsRouter, ta, th);
  registerWorkspaceTools(core.toolRegistry, toolsRouter, ta, th, core.spillStore, core.accessControl, core.config.kbDirName, sessionOntologyGate, core.routineWritePolicy, core.sessionSink);
  registerSkillsTools(core.toolRegistry, toolsRouter, ta, th, core.skillService);
  registerToolManualsTools(core.toolRegistry, toolsRouter, ta, th, core.toolManualService, {
    accessControl: core.accessControl,
    // The vault satisfies the module's local VariableStatusPort — `list_tool_setup`
    // reports configuration booleans only; secret values never ride through tools.
    variableStatus: core.secretsVaultService,
  });
  // Overlay tool registrations (defs + module-hosted endpoints).
  ext.tools?.({
    registry: core.toolRegistry,
    router: toolsRouter,
    toolAuth: ta,
    toolHandler: th,
    sessionOntologyGate,
    core,
  });
  toolsRouter.use(createManualRoutes(
    core.toolRegistry,
    core.manualAuthMiddleware,
    async (userId) => (await core.authService.getUserById(userId))?.email,
  ));
  // The aggregated manual list (KB + the caller's accessible `.tool`s) + inline
  // `.tool` sub-manuals. Mounted on the tools router so they share `manualAuth`
  // and sit before the JWT `/api` mounts.
  toolsRouter.use(createToolManualsAgentRoutes(
    core.toolManualService,
    core.manualAuthMiddleware,
    async (userId) => (await core.authService.getUserById(userId))?.email,
  ));
  app.use('/api', toolsRouter);

  // Non-JWT overlay surfaces that sit between the tools router and the
  // JWT-protected `/api` routes (LLM proxy, embed, upload — see the phase
  // doc on ServerExtensions.postTools).
  ext.postTools?.(app, core);

  // Protected routes
  app.use('/api', core.authMiddleware, createWorkspaceRoutes(
    core.workspaceService,
    core.authService,
    core.workflowService,
    core.eventBus,
    core.accessControl,
    core.config.kbDirName,
    core.creatorAccess,
  ));
  // Workflow is the only branches / changes / change-request surface. The
  // former /git/*, /pr/*, /pr/:n/* routes are gone — every consumer goes
  // through /workflow/* now.
  app.use('/api', core.authMiddleware, createWorkflowRoutes(
    core.workflowService,
    core.workspaceService,
    core.authService,
    core.eventBus,
  ));
  // SSE event-bus surface. The route owns its own auth gating via the
  // injected middleware (which accepts both Bearer and the `bevel_token`
  // cookie — the cookie path is what makes EventSource work, since the
  // browser API can't set headers). Mounted as its own app.use so it
  // doesn't share an outer middleware chain with the JSON routes above.
  app.use('/api', createEventsRoutes(core.eventBus, core.authMiddleware));
  app.use('/api', core.authMiddleware, createDiffRoutes(
    core.diffService,
    core.authService,
    core.workflowService,
    core.accessControl,
    core.config.kbDirName,
  ));
  app.use('/api', core.authMiddleware, createAccessRoutes(
    core.accessControl,
    core.workspaceService,
    core.authService,
    core.workflowService,
    core.eventBus,
    core.db,
    core.config.kbDirName,
  ));
  app.use('/api', core.authMiddleware, createSkillsRoutes(core.skillService));
  // Group discovery + access requests. Browser-only (JWT): enumerating locked
  // groups is a UI affordance, and the agent surfaces keep their fail-closed
  // filtering with no knowledge of it. The display name is resolved from the
  // users table, falling back to the email when the row is missing.
  app.use('/api', core.authMiddleware, createGroupsRoutes(
    core.groupIndexService,
    core.groupAccessRequests,
    core.accessControl,
    async (req) => (req.userId ? (await core.authService.getUserById(req.userId))?.name : null)
      ?? req.userEmail!,
  ));
  // Admin-status resolver (CORE — see the note in admin-access.routes.ts;
  // the full admin router is an enterprise `ext.authed` extension).
  app.use('/api', core.authMiddleware, createAdminAccessRoutes(core.adminAccess));
  app.use('/api', core.authMiddleware, createToolManualsBrowserRoutes(core.toolManualService));
  app.use('/api', core.authMiddleware, createSecretsVaultRoutes(secretsVaultRoutesDeps));
  // The authed tail of the MCP OAuth flow: /connect calls these to describe
  // the pending authorization and, on Finish, to mint the one-time code. The
  // browser arrives via redirect with no Authorization header, so the JWT
  // middleware's bevel_token-cookie fallback is what identifies the user.
  app.use('/api', core.authMiddleware, createOAuthConsentRoutes({
    provider: core.mcpOAuthProvider,
    stateSecret: core.config.jwtSecret,
  }));

  // JWT-protected overlay routes.
  ext.authed?.(app, core);

  // In production, serve the frontend static build
  if (opts.staticDir) {
    const frontendDist = opts.staticDir;
    app.use(express.static(frontendDist));
    app.get('{*path}', (req, res) => {
      // Non-SPA namespaces must NOT resolve to index.html. In particular, an
      // OAuth well-known metadata URL the mcpAuthRouter doesn't serve (a variant
      // the client probes, e.g. the root protected-resource or a path-suffixed
      // authorization-server doc) would otherwise return `200 + HTML`, which an
      // MCP client parses as JSON → "expected object, received undefined" and
      // the whole connection fails. A clean 404 lets discovery fall through to
      // the variant we do serve. Same reasoning for stray `/api/*` gets.
      if (req.path.startsWith('/.well-known/') || req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  return app;
}
