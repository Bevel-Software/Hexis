import type { AuthProviderPlugin } from '../modules/auth/auth.routes.js';
import type { AuthUser } from '@bevel-software/platform-shared';
import {
  DEFAULT_BRANCH,
  configureBranchModel,
  validateBranchModel,
  PROTECTED_BRANCHES,
  PLUGINS_DIR,
} from '@bevel-software/platform-shared';
import { CoreConfig } from '../core-config.js';
import { getDb, type Database } from '../modules/database/connection.js';
import { runCoreMigrations } from '../modules/database/migrate.js';
import { coreMigrationsDir } from '../assets.js';
import { WorkspaceService } from '../modules/workspace/workspace.service.js';
import { RoutineWritePolicyService } from '../modules/workspace/routine-write-policy.js';
import { KbSeedService } from '../modules/workspace/kb-seed.service.js';
import { DeploymentSettingsService } from '../modules/settings/deployment-settings.service.js';

/** `a.com, b.com` → `['a.com','b.com']`, tolerating a leading `@` or `.`. */
function parseDomainList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^[@.]+/, ''))
    .filter((d) => d.length > 0);
}
import { SpillStore } from '../modules/workspace/spill-store.js';
import { UuidSessionSink, type ISessionSink } from '../modules/workspace/session-sink.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { AccountErasureService } from '../modules/auth/account-erasure.service.js';
import { OidcAuthProvider } from '../modules/auth/oidc-auth-provider.js';
import { createAuthMiddleware } from '../modules/auth/auth.middleware.js';
import { AccessControlService } from '../modules/access/access-control.service.js';
import { CreatorAccessService } from '../modules/access/creator-access.js';
import { PendingSkillsService, SkillService } from '../modules/skills/index.js';
import { ToolManualService } from '../modules/tool-manuals/index.js';
import { GroupIndexService, GroupProvisionService, JoinRequestsService } from '../modules/groups/index.js';
import {
  DbSecretsVaultService,
  McpOAuthDiscoveryService,
  registerBevelSecretsVariableLoader,
} from '../modules/secrets-vault/index.js';
import { GitService } from '../modules/workflow/git/git.service.js';
import { PullRequestService } from '../modules/workflow/git/pull-request.service.js';
import { WorkspaceMutex } from '../modules/workflow/git/mutex.js';
import { assertGitVersion } from '../modules/workflow/git/git-version.js';
import { DiffService } from '../modules/diff/diff.service.js';
import { ReviewWorkflowService } from '../modules/workflow/review-workflow/review-workflow.service.js';
import { FileLockService } from '../modules/workflow/file-lock.service.js';
import { WorkflowEventBus } from '../modules/workflow/event-bus.js';
import { FileChangeNotifier } from '../modules/workflow/file-change-notifier.js';
import { WorkflowService } from '../modules/workflow/workflow.service.js';
import { WorkflowHooks } from '../modules/workflow/workflow-hooks.js';
import { SessionOntologyService } from '../modules/workflow/session-ontology.service.js';
import { PendingCommitsService } from '../modules/workflow/pending-commits.service.js';
import {
  PendingCommitsWorker,
  consoleSystemNoticeSink,
} from '../modules/workflow/pending-commits.worker.js';
import { ensureRecoveryBotUser } from '../modules/workflow/recovery-bot.js';
import { AdminAccessService } from '../modules/admin/admin-access.service.js';
import { ExternalApiKeyService } from '../modules/tool-auth/external-api-key.service.js';
import {
  InternalTokenService,
  deriveInternalTokenSecret,
} from '../modules/tool-auth/internal-token.service.js';
import {
  createToolAuthMiddleware,
  createManualAuthMiddleware,
} from '../modules/tool-auth/tool-auth.middleware.js';
import { unmeteredLlmUsage, type ILlmUsageMeter } from '../modules/tool-auth/llm-usage-meter.js';
import { McpSessionStore } from '../modules/mcp/mcp-session-store.js';
import { McpService } from '../modules/mcp/mcp.service.js';
import { createMcpAuthMiddleware } from '../modules/mcp/mcp-auth.middleware.js';
import { BevelOAuthProvider } from '../modules/mcp/oauth/bevel-oauth-provider.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { ToolRegistry } from '../modules/tool-registry/tool-registry.js';
import { createToolContextResolver } from '../modules/tool-helpers/tool-context.js';
import { createToolHandlerFactory } from '../modules/tool-helpers/tool-handler.js';
import { TokenCrypto } from '../shared/token-crypto.js';
import { noopRecoveryAgent, type CorePorts } from './core-ports.js';

/**
 * Everything the CORE composition builds: the core services `createCoreServer`
 * mounts, plus the primitives the enterprise overlay's own construction needs
 * (db, event bus, notifier, registries, middlewares, …).
 *
 * The fields under "server-time seams" are deliberately MUTABLE: they are only
 * read when the server is built / at request time, and the enterprise overlay
 * overwrites them after `createCoreServices` returns (its implementations need
 * core services to construct). See {@link CorePorts} for the pattern.
 */
export interface CoreServices {
  config: CoreConfig;
  db: Database;
  workspaceService: WorkspaceService;
  kbSeedService: KbSeedService;
  spillStore: SpillStore;
  accessControl: AccessControlService;
  creatorAccess: CreatorAccessService;
  sessionOntologyService: SessionOntologyService;
  routineWritePolicy: RoutineWritePolicyService;
  skillService: SkillService;
  pendingSkillsService: PendingSkillsService;
  toolManualService: ToolManualService;
  groupIndexService: GroupIndexService;
  groupProvisionService: GroupProvisionService;
  joinRequestsService: JoinRequestsService;
  authService: AuthService;
  authMiddleware: ReturnType<typeof createAuthMiddleware>;
  accountErasureService: AccountErasureService;
  gitService: GitService;
  pullRequestService: PullRequestService;
  diffService: DiffService;
  reviewWorkflowService: ReviewWorkflowService;
  fileLockService: FileLockService;
  workflowService: WorkflowService;
  eventBus: WorkflowEventBus;
  fileChangeNotifier: FileChangeNotifier;
  pendingCommitsService: PendingCommitsService;
  pendingCommitsWorker: PendingCommitsWorker;
  recoveryBot: AuthUser;
  adminAccess: AdminAccessService;
  /** Deployment settings, env-first — the KB remote resolves through these. */
  settings: DeploymentSettingsService;
  /**
   * The knowledge-base directory name IN EFFECT — environment first, then the
   * stored setting, then the default. Published here because `config.kbDirName`
   * is only the environment's half of that answer: reading it directly gives
   * the empty string on any deployment configured through the setup screen, and
   * every path built from it would be wrong.
   */
  kbDirName: string;
  secretsVaultService: DbSecretsVaultService;
  externalApiKeyService: ExternalApiKeyService;
  internalTokenService: InternalTokenService;
  mcpService: McpService;
  mcpAuthMiddleware: ReturnType<typeof createMcpAuthMiddleware>;
  mcpOAuthProvider: BevelOAuthProvider;
  toolRegistry: ToolRegistry;
  toolAuthMiddleware: ReturnType<typeof createToolAuthMiddleware>;
  manualAuthMiddleware: ReturnType<typeof createManualAuthMiddleware>;
  toolHandlerFactory: ReturnType<typeof createToolHandlerFactory>;
  // ── Server-time seams (enterprise overwrites after construction) ────────
  /** `start_session` backing — core default {@link UuidSessionSink}. */
  sessionSink: ISessionSink;
  /** Connection-key LLM metering view — core default unmetered. */
  usageMeter: ILlmUsageMeter;
  /** SSO plugins the auth router mounts — same array instance as the port. */
  authProviders: AuthProviderPlugin[];
}

export async function createCoreServices(
  config: CoreConfig,
  ports: CorePorts = {},
): Promise<CoreServices> {
  // Fail fast on a runtime whose git is too old for `--no-write-fetch-head`
  // (see `git-version.ts`): every clone, fetch and refresh below depends on it,
  // so an unsupported binary is better surfaced here than at the first merge.
  await assertGitVersion();
  const db = getDb(config.databaseUrl);
  // Migrations must run BEFORE any service that reads or writes a managed
  // table. `PendingCommitsService.startupReconcile` (called later in this
  // function) hits `pending_commits` — on a fresh DB, deferring migrations to
  // after createServices would 42P01 the boot.
  //
  // DIVERGENCE vs bevel-platform's copy of this file (Phase C reconciliation):
  // upstream still calls the legacy single-folder `runMigrations(db)`; this
  // package runs its own squashed idempotent CORE history from the packaged
  // `migrations/` folder, tracked in `__drizzle_migrations_core`. An
  // enterprise overlay runs its own history AFTER this (see migrate.ts).
  await runCoreMigrations(db, coreMigrationsDir());

  // Deployment settings come next, before ANY service is built: the KB remote
  // is resolved through them, and a fresh install has none of it in the
  // environment. `load()` is env-first, so an existing deployment sees exactly
  // what it saw before — a stored row only answers where a variable is silent.
  const settings = new DeploymentSettingsService(db, config.secretsEncKey);
  await settings.load();

  /**
   * The branch model, before anything reads it. It used to be applied at import
   * time from the environment, which is what forced the frontend to bake it
   * into its bundle; it now comes through the settings store like the rest of
   * the deployment's configuration (environment first, as always).
   *
   * UNCONFIGURED IS ALLOWED, and that is the point: a fresh deployment has no
   * branch model, and refusing to boot would take away the setup screen where
   * one gets entered. What reads it before then is the setup path itself, which
   * does not need it — the bootstrap admin is recognised without a workspace.
   * `isComplete` keeps the rest of the app behind the gate until it is set, and
   * the setting is restart-to-apply because services take the value at
   * construction.
   */
  const branchModel = {
    defaultBranch: settings.resolve('defaultBranch'),
    protectedBranches: settings.resolve('protectedBranches'),
  };
  if (!validateBranchModel(branchModel)) configureBranchModel(branchModel);
  // A token supplied through the setup screen has to reach the credential
  // helper, which reads `$GITHUB_TOKEN` at call time.
  settings.syncGitTokenEnv();

  // `kbDirName` is read ONCE and threaded into a dozen services as a plain
  // string, which is why changing it needs a restart (the setting says so).
  // The remote URL and username are read per-operation instead, so an admin
  // finishing setup can clone immediately without bouncing the process.
  const kbDirName = settings.resolve('kbDirName') || 'knowledge-base';
  const workspaceService = new WorkspaceService(
    config.workspacesRoot,
    () => settings.resolve('kbRepoUrl'),
    kbDirName,
    () => settings.resolve('gitUsername') || 'x-access-token',
  );
  // Seed (or top-up) the KB remote before the first clone so the rest of the app
  // can keep assuming the remote already carries the protected branches + base
  // scaffolding — a fresh or partially-populated remote no longer needs to have
  // been forked from the standalone template.
  const kbSeedService = new KbSeedService(
    () => settings.resolve('kbRepoUrl'),
    config.kbTemplateDir,
    // Getters, not values: the branch model can arrive from the setup screen
    // after this object exists, and seeding is the first thing that needs it.
    () => [...PROTECTED_BRANCHES],
    () => DEFAULT_BRANCH,
    // The deployment owner is the initial Admin of a freshly seeded KB — the
    // same answer `SEED_ADMIN_EMAILS` used to ask for a second time.
    [config.adminEmail],
    () => settings.resolve('gitUsername') || 'x-access-token',
    // Root folders this distribution reserves on top of core's two. A plain
    // value, not a getter: these are named in the composition root rather than
    // collected on the setup screen, so there is nothing to re-read.
    ports.kbExtraRootDirs ?? [],
  );
  workspaceService.setSeedService(kbSeedService);
  // Shared, workspace-independent store for oversized `call_tool_chain` results,
  // read back via `read_file`. Sibling of `workspacesRoot`, never committed.
  const spillStore = new SpillStore(config.spillRoot);
  // The deployment owner counts as Admin for the two hardcoded `write`
  // rescues (`roles.yaml` and any `access.md`) — the SAME list
  // `AdminAccessService` below is given, so the admin surfaces and the write
  // gate cannot disagree about who the owner is. They did: the owner could
  // open Roles & Members and then be refused the save, with the UI showing
  // them as an admin and the gate saying "Eligible: Admin".
  const accessControl = new AccessControlService(workspaceService, kbDirName, [
    config.adminEmail,
  ]);
  // Creator read-grant on creation: read is default-deny, so every surface
  // that creates KB files/folders (human routes, agent tools, upload apply)
  // consults this planner to keep creations visible to their creator.
  const creatorAccess = new CreatorAccessService(workspaceService, accessControl, kbDirName);

  // Ontology-session boundary: records each agent run's touched ontologies and
  // blocks writes once a run has crossed ontologies. Postgres-backed so the
  // boundary survives a restart.
  const sessionOntologyService = new SessionOntologyService(db);
  // Per-run write restriction (by file extension). Shared by the workspace tool
  // surface (which enforces it) and the routine runner (which sets it for
  // dashboard-only `watchlist_check` runs). In-memory: a restriction lives only for
  // one run, unlike the Postgres-backed ontology touched-set above.
  const routineWritePolicy = new RoutineWritePolicyService();
  // Skills: discovered from the default-branch workspace only (global catalog).
  const skillService = new SkillService(workspaceService, accessControl, kbDirName);
  // Tool manuals: user-authored `*.tool` files under `Groups/` in the default
  // branch — access-controlled like Skills, served to external agents via
  // `GET /api/agent/all-tools` and registered on the MCP proxy's UTCP client.
  const toolManualService = new ToolManualService(workspaceService, accessControl, kbDirName);
  // Groups: the folders under `Groups/` that carry a
  // team's skills AND the tools they need. Enumerated for EVERY authenticated
  // caller — a group they cannot read still exists for them, as a locked one —
  // with the counts read off the two catalogs above rather than a second scan.
  const groupIndexService = new GroupIndexService(
    workspaceService,
    accessControl,
    skillService,
    toolManualService,
    kbDirName,
  );
  // Auth service — resolves identities for login, PR author attribution, and
  // access lookups. (Change requests now store the author email directly, so
  // PullRequestService no longer depends on it for attribution.)
  // The allow-list is resolved, not read off the environment: it is settable
  // from the setup screen alongside the SSO configuration it guards.
  const authService = new AuthService(db, {
    jwtSecret: config.jwtSecret,
    adminEmail: config.adminEmail,
    adminPassword: config.adminPassword,
    allowedEmailDomains: parseDomainList(settings.resolve('allowedEmailDomains')),
  });
  const authMiddleware = createAuthMiddleware(authService);

  // Shared mutex so git and diff operations on the same workspace serialize
  // against each other — a backup-reseed races a concurrent commit otherwise.
  const workspaceMutex = new WorkspaceMutex();
  // Workflow lifecycle hooks — the ONE registry this composition shares
  // between GitService (advisory commit validation), the session-ontology
  // gate (blocking preWrite), and the enterprise composition root, which
  // registers module-owned handlers on `workflowService.hooks` right after
  // this function returns. Core registers none: no commit-time validation
  // (advisory anyway) and no ontology write block.
  const workflowHooks = new WorkflowHooks();
  const gitService = new GitService(
    workspaceService,
    workflowHooks,
    kbDirName,
    workspaceMutex,
    accessControl,
  );
  // A fresh clone has already fetched every ref — let the git layer skip the
  // redundant implicit `git fetch` on the first `listBranches` after bootstrap.
  workspaceService.setWorkspaceClonedListener((id) => gitService.noteWorkspaceFetched(id));
  const pullRequestService = new PullRequestService(
    db,
    workspaceService,
    accessControl,
    gitService,
  );
  const diffService = new DiffService(
    workspaceService,
    workspaceMutex,
    config.workspacesRoot,
    config.backupsRoot,
    kbDirName,
  );
  // Late-bind the diff service into WorkspaceService so file writes/moves
  // trigger backup updates. (GitService used to take a diffService too — for
  // the post-switch backup reseed — but switchBranch is gone with the
  // per-branch workspace model, so the injection no longer applies.)
  workspaceService.setDiffService(diffService);
  const reviewWorkflowService = new ReviewWorkflowService(
    db,
    accessControl,
    workspaceService,
    gitService,
  );
  // Late-bind the comment enricher so PullRequestService.getPrDetail includes
  // our DB-backed comments without forcing a circular constructor dependency.
  pullRequestService.setDetailEnricher(reviewWorkflowService);

  // Workflow facade — the abstraction every app consumer should reach for
  // instead of the individual git / PR / review-workflow services. See
  // PLAN.md for the migration story. Today it delegates straight through;
  // implementations migrate into the workflow module over later steps.
  const fileLockService = new FileLockService(db);
  // Background commit queue. The `WorkflowService.releaseLock` path
  // enqueues a row here instead of running commitFile + push inline; the
  // worker drains the queue out of band so a git hiccup can't block the
  // user-visible save path. See `lock-decoupling-plan.md`.
  const pendingCommitsService = new PendingCommitsService(db);
  // Let the git status path tell an expected dirty tree from a genuinely
  // orphaned one before it warns loudly. Two innocent explanations: queued
  // saves still draining through the worker, and a lock currently HELD —
  // deletes and saves mutate the disk while the lock is held but only queue
  // their commit at release, so a status poll landing inside that window sees
  // dirt with an empty queue (observed on multi-folder deletes).
  gitService.setPendingCommitsProbe(async (workspaceId) =>
    (await pendingCommitsService.hasAnyForWorkspace(workspaceId)) ||
    (await fileLockService.hasAnyActive(workspaceId)),
  );
  // In-process event bus: every WorkflowService mutation method that
  // succeeds emits a typed event; the SSE route fans it to connected
  // browser sessions. Single instance per Node process — survives across
  // requests, doesn't survive restarts (clients reconnect + resync).
  const eventBus = new WorkflowEventBus();
  // In-process post-commit hook (distinct from the SSE bus): fires once per
  // committed change (batched paths) so catalogs refresh instantly and the
  // id-repair keeps the id namespace collision-free. Subscribers are registered
  // below, once the reacting services exist.
  const fileChangeNotifier = new FileChangeNotifier();
  const workflowService = new WorkflowService(
    db,
    gitService,
    pullRequestService,
    reviewWorkflowService,
    workspaceService,
    accessControl,
    fileLockService,
    pendingCommitsService,
    kbDirName,
    eventBus,
    fileChangeNotifier,
    // Exposed as `workflowService.hooks` — the SAME instance GitService and
    // the session-ontology gate consult, so enterprise registrations against
    // it reach every hook point.
    workflowHooks,
  );

  // Join requests: derived entirely from two copies of a group's `access.md`
  // (the request's branch vs the default branch), so it holds no state — it
  // only needs to read files at refs and to close a request whose proposals
  // have all landed.
  const joinRequestsService = new JoinRequestsService(workspaceService, workflowService);
  // Group provisioning — the one privileged door that brings `Groups/<name>/`
  // folders into existence (named groups and personal folders alike). Commits
  // INLINE through the same pipeline the pending-commits worker uses, so the
  // folder's rules are at HEAD before the endpoint answers.
  const groupProvisionService = new GroupProvisionService(
    workspaceService,
    workflowService,
    accessControl,
    kbDirName,
    eventBus,
  );

  // Pending skills: the other half of the catalog — skills that exist only on
  // an open change request's branch. Built here rather than beside
  // `skillService` because it needs the workflow service, which does not exist
  // that early; it holds no state of its own, so where it is constructed is the
  // only thing the ordering decides.
  const pendingSkillsService = new PendingSkillsService(
    workspaceService,
    accessControl,
    skillService,
    workflowService,
  );

  // Subscriber A — catalog freshness: a committed change drops the affected
  // caches immediately instead of waiting out their TTLs. The tool/skill
  // catalogs are global but read the DEFAULT branch only, so only
  // default-branch changes under their folders matter. (The kb-graph id-index
  // invalidation that used to live in this subscriber is registered by the
  // enterprise overlay, next to the kb-graph service it belongs to — the
  // caches are independent, so the split preserves behavior.)
  fileChangeNotifier.onFilesChanged(({ branch, paths }) => {
    if (branch !== DEFAULT_BRANCH) return;
    // Skills, tools and the group index all live under `Groups/`, so one
    // touch check drives all three caches. An access grant lands as a
    // default-branch change to `Groups/<group>/access.md`, so this is also
    // what makes a newly-granted group unlock within one round-trip instead
    // of one TTL.
    const touched = paths.some((p) => p.startsWith(`${kbDirName}/${PLUGINS_DIR}/`));
    if (touched) {
      toolManualService.invalidate();
      skillService.invalidate();
      groupIndexService.invalidate();
    }
  });

  // Subscriber B — WRITE-time freshness for the same three caches. The
  // workspace routes emit `fs-tree-changed` the moment bytes hit a working
  // tree; Subscriber A above fires only when the ASYNC commit lands. Between
  // the two, "create a skill, reload the catalog" raced the commit pipeline
  // and lost — the new skill's card stayed invisible until a refresh outlived
  // the TTL. The catalogs scan the working tree anyway, so invalidating at
  // write time makes the very next read see the file. No path filter: this
  // event carries none, and a spurious drop only costs one re-scan.
  eventBus.onEmit((event) => {
    if (event.kind !== 'fs-tree-changed') return;
    if (!('branch' in event) || event.branch !== DEFAULT_BRANCH) return;
    toolManualService.invalidate();
    skillService.invalidate();
    groupIndexService.invalidate();
  });

  // Admin = `Admin` role in roles.yaml, resolved through the access model on the
  // default branch (no env allow-list).
  const adminAccess = new AdminAccessService(
    accessControl,
    workspaceService,
    () => DEFAULT_BRANCH,
    // The deployment owner administers accounts/roles even before the KB's
    // roles.yaml lists them, and whatever the sign-in method — this list is
    // consulted before any roles.yaml lookup, so it holds for SSO too.
    // Required by CoreConfig, hence no empty case.
    [config.adminEmail],
  );

  // Secrets Vault: the per-user store of credentials (static API keys + OAuth
  // tokens) that back UTCP tool variables (`${FOO_API_KEY}`). Encrypted at rest
  // with the connector-config key; read only by the `bevel-secrets` variable
  // loader at tool-call time. Swap-seam: `ISecretsVaultService` could later be a
  // client's external secret manager without touching the loader or the tools.
  const secretsVaultService = new DbSecretsVaultService(
    db,
    config.secretsEncKey,
    undefined,
    // Scope-driven resolution: a `.tool`'s declared variable scope decides whether
    // `resolve` reads the shared (admin) row or the caller's own per-user row.
    (key) => toolManualService.scopeOfVariable(key),
  );
  // Register the `bevel-secrets` UTCP variable loader against this vault so any
  // UTCP client can resolve `${VAR}` from the caller's secrets at tool-call time.
  registerBevelSecretsVariableLoader(secretsVaultService);

  // Zero-config OAuth for bare `type: mcp` `.tool`s: when the remote server
  // demands OAuth (MCP authorization spec), discover its authorization server,
  // dynamically register a public PKCE client, and persist the provider as the
  // shared vault row — the tool catalog then decorates the manual with a
  // synthetic per-user sign-in. Setter-injected: this service needs the vault,
  // which is constructed after the tool-manual service.
  const mcpOAuthDiscovery = new McpOAuthDiscoveryService({
    secretsVault: secretsVaultService,
    redirectUri: `${config.publicBackendUrl}/api/secrets/oauth/callback`,
  });
  toolManualService.setMcpAuthDiscovery(mcpOAuthDiscovery);

  // Least-privilege internal tokens: minted per (workspace, user, scope) by the
  // agents' code-mode clients and by the MCP proxy, verified by the tool-auth
  // middleware below. The signing key is STABLE across processes sharing the
  // deployment env (INTERNAL_TOKEN_SECRET, else derived from JWT_SECRET) so a
  // sibling process — the enterprise routine CLI, a second replica — mints
  // tokens this server verifies. Only a deployment with NO jwtSecret at all
  // falls back to the per-boot random key (single-process smoke setups).
  const internalTokenSecret =
    config.internalTokenSecret ||
    (config.jwtSecret ? deriveInternalTokenSecret(config.jwtSecret) : undefined);
  const internalTokenService = new InternalTokenService({
    prefix: config.internalTokenPrefix,
    secret: internalTokenSecret,
  });

  // GDPR erasure path: admin-driven user deletion. The core service erases the
  // rows it owns; each module contributes its slice as a participant.
  const accountErasureService = new AccountErasureService(db, ports.erasureParticipants ?? []);

  // MCP (remote agent access). ExternalApiKeyService handles connection-key
  // lifecycle; McpSessionStore holds per-session userId in memory
  // (single-replica — see docs/mcp-remote-access.md). McpService is now a
  // GENERIC proxy: per session it discovers the UTCP manual at /api/agent/utcp
  // over loopback and re-exposes every tool, dispatching calls back through the
  // REST tool surface (so agent logic + metering live there, once).
  const externalApiKeyService = new ExternalApiKeyService(db, config.externalApiKeyPrefix);
  const mcpSessionStore = new McpSessionStore();
  const mcpService = new McpService(
    mcpSessionStore,
    {
      // Loopback to our own REST tool surface — 127.0.0.1 (not localhost) to pin
      // IPv4 and dodge resolver ambiguity. The proxy authenticates each call with
      // the caller's own connection key.
      loopbackBaseUrl: `http://127.0.0.1:${config.port}`,
      // Manual namespace + UTCP variable prefix (KNOWLEDGE_BASE_API_URL / …).
      manualName: 'KNOWLEDGE_BASE',
      // Oversized chain results spill here too — an external MCP session has no
      // ambient workspace, so it reads the spill back by ref via `read_file`.
      spillStore,
      // For the needs-authorization setup link surfaced to external agents.
      publicFrontendUrl: config.publicFrontendUrl,
    },
    // Pre-dispatch per-user credential check: the vault answers "has this caller
    // set it?" and the manual catalog answers "which user-scoped vars does this
    // tool need?".
    secretsVaultService,
    toolManualService,
    // Loopback bearer mint for OAuth/JWT sessions — their own bearer would
    // 401 at the connection-key/internal-only /api/agent/* hop.
    internalTokenService,
    // Session-grant reset for broken tool sign-ins. A closure because the
    // provider is constructed just below (it needs nothing from McpService;
    // the binding is only dereferenced at call time, long after boot).
    (bearer) => mcpOAuthProvider.revokeByAccessToken(bearer),
  );
  // A changed secret invalidates the proxy's remembered manual failures for
  // that user (null = shared secret → everyone), so a just-repaired
  // credential is retried on the very next session build instead of waiting
  // out the failure memo's TTL.
  secretsVaultService.onMutation((changedUserId) => mcpService.clearManualFailures(changedUserId));
  // MCP OAuth 2.1 authorization server (our own AS): lets MCP clients with no
  // pre-shared connection key connect via the standard 401 → discovery → DCR →
  // authorize (PKCE) flow. The authorize step routes the browser to /connect
  // where the user configures their tools; the resulting access token resolves
  // to that user in the MCP auth middleware, like a connection key.
  const mcpOAuthProvider = new BevelOAuthProvider({
    db,
    crypto: config.secretsEncKey ? new TokenCrypto(config.secretsEncKey) : null,
    stateSecret: config.jwtSecret,
    publicFrontendUrl: config.publicFrontendUrl,
    tokenPrefix: config.mcpOAuthTokenPrefix,
  });
  // RFC 9728 pointer carried on every MCP 401 challenge so OAuth-capable
  // clients discover the AS. Single source of truth for the resource id.
  const mcpResourceUrl = new URL('/api/mcp', config.publicBackendUrl);
  const mcpResourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpResourceUrl);
  const mcpAuthMiddleware = createMcpAuthMiddleware(
    authService,
    externalApiKeyService,
    mcpOAuthProvider,
    mcpResourceMetadataUrl,
  );

  // ── Unified tool surface ──────────────────────────────────────────────
  // ONE catalog of self-describing UTCP tools, served as two manuals (external
  // for CI/MCP; internal for our agent's loopback code-mode client) and hosted
  // by each owning module behind shared auth + context utilities. The core
  // server assembles the router (registers tool defs + mounts endpoints). The
  // `internalTokenService` minted above (shared with the agent factories) is
  // the same one the tool-auth middleware verifies internal tokens against.
  const toolRegistry = new ToolRegistry();
  const resolveToolContext = createToolContextResolver({
    authService,
    workspaceService,
    workflowService,
    events: eventBus,
    kbDirName: kbDirName,
    creatorAccess,
  });
  const toolHandlerFactory = createToolHandlerFactory(resolveToolContext);
  const toolAuthMiddleware = createToolAuthMiddleware(externalApiKeyService, internalTokenService);
  // Read-only manual endpoints accept the above PLUS a browser JWT, so a
  // logged-in user can browse the catalog with their session. Execution routes
  // keep `toolAuthMiddleware` (no JWT), so a session can read but not invoke.
  const manualAuthMiddleware = createManualAuthMiddleware(externalApiKeyService, internalTokenService, authService);

  // Recovery-bot identity: a synthetic `recovery-bot@bevel.local` user
  // backing (a) the recovery agent's commit authorship and (b) the
  // `'system'` feedback notice's user_id FK. Idempotent ensure so this
  // is safe to call on every boot.
  const recoveryBot = await ensureRecoveryBotUser(db);

  // Background commit worker. Drains `pending_commits` rows that the
  // refactored `releaseLock` enqueues. On terminal failure (transient
  // retry budget AND recovery-agent budget exhausted) the worker emits
  // a `'system'` feedback notice that admins triage out of band.
  //
  // The orphan-startup sweep runs BEFORE start() so any rows that
  // previous deploys left as `running` (process crashed mid-commit) get
  // reset to `pending` before the worker starts claiming. The sweep
  // also enqueues working-tree dirt that pre-dates the queue (the
  // existing `target-company-state` orphans).
  await pendingCommitsService.startupReconcile(
    workspaceService.knownWorkspaces(),
    { scan: (ws) => workspaceService.scanOrphanedPaths(ws.id) },
    { email: recoveryBot.email, name: recoveryBot.name },
  );
  const pendingCommitsWorker = new PendingCommitsWorker({
    service: pendingCommitsService,
    // The service IS the driver — passed directly rather than wrapped in a
    // forwarding lambda. A lambda that names its parameters silently drops any
    // the interface later adds (TypeScript accepts a shorter parameter list),
    // and that is not hypothetical: the wrapper here took four arguments and
    // swallowed the `opts` carrying `skipValidation`, so the burst-validation
    // skip was a no-op in production while every unit test — which stubs this
    // port — passed. No wrapper, no gap to fall through.
    workflow: workflowService,
    // Both escalation sinks come through CorePorts: the recovery agent and the
    // notice sink are enterprise-owned (background-agent factory / feedback
    // dashboard); core defaults skip recovery and log to stderr.
    recoveryAgent: ports.recoveryAgent ?? noopRecoveryAgent,
    feedback: ports.systemNotice ?? consoleSystemNoticeSink,
    workspaces: {
      knownWorkspaces: () => workspaceService.knownWorkspaces(),
    },
    recoveryBot: {
      id: recoveryBot.id,
      email: recoveryBot.email,
      name: recoveryBot.name,
    },
  });
  pendingCommitsWorker.start();

  // SSO providers. The array REFERENCE is shared with the caller's port — an
  // overlay pushes its own plugins into it after construction (they mount when
  // the server is built, later). Core contributes the generic OIDC provider
  // when the env configures one.
  const authProviders = ports.authProviders ?? [];
  // Resolved through settings, so an admin can configure SSO from the setup
  // screen instead of the environment. Env still wins, so a deployment that
  // sets these keeps behaving exactly as it did.
  const oidcIssuerUrl = settings.resolve('oidcIssuerUrl');
  const oidcClientId = settings.resolve('oidcClientId');
  const oidcClientSecret = settings.resolve('oidcClientSecret');
  if (oidcIssuerUrl && oidcClientId && oidcClientSecret) {
    authProviders.push(
      new OidcAuthProvider({
        issuerUrl: oidcIssuerUrl,
        clientId: oidcClientId,
        clientSecret: oidcClientSecret,
        scopes: settings.resolve('oidcScopes') || 'openid profile email',
        label: settings.resolve('oidcProviderLabel') || 'Single sign-on',
        publicBackendUrl: config.publicBackendUrl,
        publicFrontendUrl: config.publicFrontendUrl,
        cookieSecure: config.publicBackendUrl.startsWith('https'),
      }),
    );
  }

  return {
    config,
    db,
    workspaceService,
    kbSeedService,
    settings,
    kbDirName,
    spillStore,
    accessControl,
    creatorAccess,
    sessionOntologyService,
    routineWritePolicy,
    skillService,
    pendingSkillsService,
    toolManualService,
    groupIndexService,
    groupProvisionService,
    joinRequestsService,
    authService,
    authMiddleware,
    accountErasureService,
    gitService,
    pullRequestService,
    diffService,
    reviewWorkflowService,
    fileLockService,
    workflowService,
    eventBus,
    fileChangeNotifier,
    pendingCommitsService,
    pendingCommitsWorker,
    recoveryBot,
    adminAccess,
    secretsVaultService,
    externalApiKeyService,
    internalTokenService,
    mcpService,
    mcpAuthMiddleware,
    mcpOAuthProvider,
    toolRegistry,
    toolAuthMiddleware,
    manualAuthMiddleware,
    toolHandlerFactory,
    // Server-time seams — defaults here; the enterprise overlay overwrites
    // (or, for the array, pushes into) these after construction.
    sessionSink: ports.sessionSink ?? new UuidSessionSink(),
    usageMeter: ports.usageMeter ?? unmeteredLlmUsage,
    authProviders,
  };
}
