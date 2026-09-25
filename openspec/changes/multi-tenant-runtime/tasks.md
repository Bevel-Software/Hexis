## 1. Shared pure API (packages/shared) — phase 1

- [x] 1.1 `src/git/protected.ts`: `BranchModelValue`, `UNCONFIGURED_BRANCH_MODEL`, `resolveBranchModel(model)`, `isBranchModelConfigured(model)`, `isProtectedBranch(model, name)`, `protectedBranchDisplayName(model, name)`, `currentBranchModel()`; the live bindings and `configureBranchModel` stay for the browser
- [x] 1.2 `src/workspace/kb-layout.ts`: `resolveKbLayout(layout)`; every helper takes a required layout or guide name (`agentsFilePointerSentence`, `retargetAgentsFilePointer`, `mentionsAgentsFile`, `validateAgentsFileName`, `isDefaultKbLayout`, `renderKbLayoutPlaceholders`, `isPersonalPluginDir`, `pluginOfPath`, `ontologyRoots`, `reservedRootDirNames`, `creatableRootDirNames`)
- [x] 1.3 `src/workspace/platform-files.ts`: `platformFileNames(layout)`, `isPlatformFile(path, layout)`, `isPlatformFolder(dir, layout)`, `isRootPlatformFile(path, layout)`, `platformRestoreDestination(dest, layout)`, `isPlatformRestoreShape(src, dest, layout)`

## 2. Backend `KbContext` (packages/core-backend) — phase 1

- [x] 2.1 `src/shared/kb-context.ts`: the class with live getters, `defaultWorkspaceId()`, `applyBranchModel`, `applyLayout`, `onLayoutApplied`, `onBranchModelApplied`, `branchModelOrUnconfigured`
- [x] 2.2 `src/core/create-core-services.ts`: build the context after `assertKbDirNameFree`, pass it to every service in the former `kbDirName` slot, expose it as `CoreServices.kb`, mirror onto the shared bindings under `CorePorts.mirrorSharedBindings` (default true)
- [x] 2.3 `src/core/create-core-server.ts`, `public-config.ts`, `catalog-cache-invalidation.ts`: read the context instead of the bindings
- [x] 2.4 Modules: access (`access-control.service.ts` trailing optional `kb`, `access.routes.ts`, `change-read-gate.ts`, `creator-access.ts`), agent-instructions (`read-preamble.ts`), kb-fs (`branch-name.ts`), plugins (`plugins.service.ts`, `plugin-links.ts`, `plugin-links.service.ts`, `plugin-provision.service.ts`, `plugin-rename.service.ts`, `join-requests.service.ts`, `join-request-jobs.service.ts`, `plugins.routes.ts`, `teams.routes.ts`, `compile/marketplace-compiler.service.ts`, `discovery/kb-plugin-source.ts`, `native.source.ts`, `bundle-dialect/bundle.source.ts`), secrets-vault (`secrets-vault.routes.ts`), settings (`setup.routes.ts` applies to the context, `deployment-settings.service.ts`), skills (`allowed-tools-check.ts`, `pending-skills.service.ts`, `skill-access-requests.routes.ts`, `skills.routes.ts`, `skills.service.ts`), tool-manuals (`mcp-json-discovery.ts`, `mcp-server-edit.service.ts`, `pending-tools.service.ts`, `tool-delete.service.ts`, `tool-manuals.routes.ts`, `tool-manuals.service.ts`, `tool-manuals.tools.ts`), workflow (`agent-tools/workflow.tools.ts`, `git/git.service.ts`, `session-ontology.service.ts`, `workflow.service.ts`), workspace (`session-ontology.gate.ts`, `startup/kb-startup-runner.ts`, every `startup/steps/*`, `workspace.routes.ts`, `workspace.service.ts`, `workspace.tools.ts` with the layout listener, `write-denial.ts`), `shared/kb-layout.ts`, `shared/pending-proposals.ts`
- [x] 2.5 `eslint.config.js`: `no-restricted-imports` for the bindings in `packages/core-backend/src/**` and `packages/mcp-core/src/**`, `__tests__` and `test-setup.ts` exempt; one `eslint-disable-next-line` at the mirror site
- [x] 2.6 `src/__tests__/kb-context.ts`: `TEST_BRANCH_MODEL` and `testKbContext({ kbDirName?, branchModel?, layout? })`; every suite that constructed a service with `kbDirName` passes a context; suites that reconfigured the shared bindings apply to their own context instead (`steps.test.ts`, `kb-plugin-source.test.ts`, `bundle-dialect.e2e.test.ts`, `workspace.tools.agents-file.test.ts`, `setup.routes.test.ts`, `setup.routes.layout-phase.test.ts`, `merge-announces-tree.test.ts`)

## 3. Frontend (packages/core-frontend) — phase 1

- [x] 3.1 Pass `currentKbLayout()` / `currentBranchModel()` to the shared helpers in `fileTree.ts`, `treeConfirm.ts`, `library-paths.ts`, `plugin-summary.ts`, `ReviewPanel.tsx`, `useFileAccess.ts`, `BranchSwitcher.tsx`, `FileComparisonPanel.tsx`, `PullNeededBanner.tsx`, `error-messages.ts`, `OpenChangeRequestDialog.tsx`, `FileExplorer.tsx`, `useWorkspaceState.ts`

## 4. Docs and release — phase 1

- [x] 4.1 This change folder
- [x] 4.2 `Architecture.md`: the per-knowledge-base context rule under Dependency Injection
- [x] 4.3 Changeset for the fixed version group naming the shared API change for overlay authors
- [x] 4.4 `pnpm typecheck`, `pnpm lint`, `pnpm test` green (the backend cases that still fail on a Windows workstation, symlinks, CRLF, `chmod 0` and turn timing, fail identically on an untouched `dev` checkout there; CI on Linux is the authority)

## 5. Git credentials provider (packages/core-backend) — phase 2

- [x] 5.1 `src/shared/git.contract.ts`: `GitCredentials { username(); token() }`, `gitCredentials()`, `NO_GIT_CREDENTIALS`, `GIT_TOKEN_ENV`; `redactGitToken(text, token)`; `IGitRunner.credentials`
- [x] 5.2 `modules/workflow/git/node-git-runner.ts`: take the provider, set `GITHUB_TOKEN` in the child env only and drop an inherited one; a per-call env entry still wins (the setup probe); tests through `git credential fill`
- [x] 5.3 `modules/settings/deployment-settings.service.ts`: drop `syncGitTokenEnv`; the composition root's provider reads `resolve('gitToken')`
- [x] 5.4 `src/core-config.ts`: `gitToken` read from `GIT_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN`, never written back
- [x] 5.5 `modules/kb-fs/clone-config.ts` (helpers take the credentials), `modules/workspace/startup/kb-git.ts` and `kb-startup-runner.ts` (the runner's credentials; `gitUsername`/`gitToken` options gone), `modules/workspace/workspace.service.ts` (the `gitUsername` parameter gone; runner credentials), `modules/workflow/git/git.service.ts` (`credentials` getter), `workflow.service.ts`, `review-workflow.service.ts`: read the provider
- [x] 5.6 Tests: `node-git-runner.test.ts` (token reaches the child, stale env token dropped, per-call override, failures scrubbed), `clone-config.test.ts`, `kb-startup-runner.test.ts` (token by provider, rotation without restart), `deployment-settings.service.test.ts` (a saved token stays out of `process.env`)

## 6. Database per schema, config split, secrets loader (packages/core-backend) — phase 3

- [x] 6.1 `modules/database/connection.ts`: `createDb(url, { schema, max, idleTimeoutMillis })` with `search_path` as a startup parameter, `getDb` cached per (url, schema), `closeDb`, `dbSchemaOf`, `assertSchemaName`; tests in `__tests__/connection.test.ts`
- [x] 6.2 `modules/database/migrate.ts`: the ledger lives in the tenant's schema (`migrationsSchema`) and the lock is keyed by it; the default schema keeps drizzle's ledger
- [x] 6.3 `migrations/0000_core_init.sql`: `to_regclass('<table>')` for the 7 guards; `__tests__/migrations-unqualified.test.ts` reads every packaged migration for `public.`
- [x] 6.4 `modules/database/advisory-lock.ts`: `advisoryLockKey(lock, tenantKey)` = `lock ^ crc32(tenantKey)`, empty key unchanged; `{ tenantKey }` on `withAdvisoryLock` and `AdvisoryLease`; tests
- [x] 6.5 `src/core-config.ts`: `TenantConfig` and `ProcessConfig`; `CoreConfig implements` both and reads `DB_SCHEMA`; `createCoreServices(config: TenantConfig, ports)` creates the schema on first use
- [x] 6.6 `modules/secrets-vault/secrets-variable-loader.ts`: vaults by scope, descriptor carries `scope`, `unregisterBevelSecretsVariableLoader`; `McpProxyOptions.secretsScope`, `ConnectionProbeService`'s third argument; the composition root scopes a non-default schema as `<tenantId>/<schema>`

## 7. Lifecycle split (packages/core-backend) — phase 4

- [x] 7.1 `src/core/lifecycle.ts`: `startCore(core, ext)` and `stopCore(core)`; `createCoreServer` calls `startCore` at the same point of its mount order (`opts.boot`, default true) and `createShutdown` runs the same release sequence after closing the server
- [x] 7.2 `CoreServices.startupRetry` holds the `retryUntilMaintained` handle; `stopCore` and the shell's shutdown stop it; `CoreServices.tenantKey` and `secretsScope` name what the graph registered
- [x] 7.3 Timer audit: the join-request sweep and heartbeat (stopped and drained), the commit worker (lease loop), the startup retry (handle), the SSE heartbeat (per connection, closed with the server), the connection probe, tool-chain kill timer and locking-filesystem sleeps (per call, bounded), the synced-groups debounce (per instance, file-only)
- [x] 7.4 `core/__tests__/lifecycle.test.ts`: `stopCore` order, the retry stopped, the secrets scope forgotten, no retry and no scope, the budget

## 8. Tenancy module, host, apps/server, docs (packages/core-backend, apps/server) — phase 5

- [x] 8.1 `src/tenancy/tenant-source.contract.ts`, `static-tenant-source.ts` (records, `tenantConfigFrom`, `tenantHostEnv`), `tenant-secrets.ts` (HKDF-SHA256), `tenant-runtime.ts`, `tenant-host.ts`; exported from `index.ts`
- [x] 8.2 Loopback by PATH PREFIX rather than a header: `TenantConfig.loopbackBaseUrl` names the tenant as `http://127.0.0.1:<port>/_tenant/<slug>`, which the MCP proxy dials and seeds into its UTCP manuals (a header cannot ride a UTCP call, and the proxy reshapes nothing); the host honours the prefix from loopback peers only
- [x] 8.3 `apps/server/src/main.ts` runs a host when `TENANTS_FILE` is set; `shell.ts` stops a host (`ShellHost`) where it stops a single graph's worker
- [x] 8.4 Tests: `tenancy/__tests__/` — secrets derivation, the static source and env, the runtime (activate once under a burst, failed activation retried, eviction mid-activation, idle and busy), the host over real sockets (host to tenant, unknown host 404, process health, loopback prefix from 127.0.0.1 and only a slug-shaped one, 503 while starting and after a failed start, idle sweep and reactivation); `apps/server` shell host-mode shutdown. The two-tenants-in-one-database integration run is manual (see 10.2)
- [x] 8.5 `docs/multi-tenant.md`, rows in `docs/configuration.md`, `.env.example` section 7, README reference, changeset

## 9. Seat admission port (packages/core-backend) — phase 6

- [x] 9.1 `modules/auth/account-admission.ts` (`IAccountAdmission`, `admitEveryone`, `AccountAdmissionRefusedError`); `src/core/core-ports.ts`: `accountAdmission`
- [x] 9.2 `modules/auth/auth.service.ts`: asked before the insert on every path that creates a row (`sso`, `admin-create`, `bootstrap`, `embed`), never for an address that already has one; `account.routes.ts` answers 403 with the port's words, the OIDC callback redirects with `#error=admission` and the login screen names it
- [x] 9.3 Tests: `auth.service.test.ts` (refusal on SSO and on admin create with nothing inserted, an existing address never asked about, the reasons named, the default admits without a lookup), `account.routes.test.ts` (403)

## 10. Verification

- [x] 10.1 `pnpm typecheck` green for every package; backend, frontend and server suites green except the Windows-only cases noted at 4.4
- [x] 10.2 Manual, run 2026-09-25 against the local PostgreSQL 18: `TENANTS_FILE` with `a.localhost` / `b.localhost` on one database; both tenants activated on first request (schemas `t_a` / `t_b`, 20 tables each, their own users); each `/api/config` reported its own branch model; the owner of A could not sign in on B and A's session token was refused on B; a change request opened on A was listed on A and absent from B; the loopback prefix `/_tenant/b/…` reached B from 127.0.0.1 and an unknown slug got 404; `pg_dump --schema=t_a` restored into a fresh database booted as a single-tenant deployment with `DB_SCHEMA=t_a` and the derived secrets: the ledger was honoured (no migration re-ran), the owner signed in, and the change request was listed. The run also caught the quoted `"public"."users"` foreign-key targets drizzle had generated in four migrations, fixed in the same commit. Not exercised: `hexis-mcp` against a tenant (the loopback prefix it depends on is covered above and by the host suite)
