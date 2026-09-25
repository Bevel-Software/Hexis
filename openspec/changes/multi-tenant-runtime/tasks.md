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

- [ ] 6.1 `modules/database/connection.ts`: `createDb(url, { schema })` with `search_path`, cache keyed by url and schema, `close()`; `getDb(url)` stays as the single-tenant wrapper; schema name validated
- [ ] 6.2 `modules/database/migrate.ts`: `migrationsSchema` per schema for core and enterprise migrations
- [ ] 6.3 `migrations/0000_core_init.sql`: `to_regclass('<table>')` for the 7 guards; a test that greps `migrations/*.sql` for `public.`
- [ ] 6.4 `modules/database/advisory-lock.ts`: `{ tenantKey }` on `withAdvisoryLock` and `AdvisoryLease`, second int `lock ^ crc32(tenantKey)`; test that the empty key equals today's ids
- [ ] 6.5 `src/core-config.ts`: `TenantConfig` and `ProcessConfig`; `CoreConfig implements TenantConfig`; `createCoreServices(config: TenantConfig, ports)`
- [ ] 6.6 `modules/secrets-vault/secrets-variable-loader.ts` and its callers (`create-core-services.ts`, `mcp/mcp.service.ts`, `secrets-vault/connection-probe.service.ts`): loader map keyed by tenant

## 7. Lifecycle split (packages/core-backend) — phase 4

- [ ] 7.1 `src/core/lifecycle.ts`: `startCore(core, ext)` and `stopCore(core)`; `createCoreServer` and `createShutdown` call them
- [ ] 7.2 Keep the `retryUntilMaintained` handle on `CoreServices` and stop it in `stopCore`
- [ ] 7.3 Timer audit: `join-request-jobs.service.ts`, `pending-commits.worker.ts`, `kb-startup-runner.ts`, `events.routes.ts`, `locking-filesystem.ts`, `tool-delete.service.ts`, `connection-probe.service.ts`, `workspace.tools.ts`, `synced-groups-writer.ts`, `advisory-lock.ts`
- [ ] 7.4 Test: after `stopCore` no handle of the graph is alive

## 8. Tenancy module, host, apps/server, docs (packages/core-backend, apps/server) — phase 5

- [ ] 8.1 `src/tenancy/tenant-source.contract.ts`, `static-tenant-source.ts`, `tenant-secrets.ts` (HKDF-SHA256), `tenant-runtime.ts`, `tenant-host.ts`; exported from `index.ts`
- [ ] 8.2 `modules/mcp/mcp.service.ts`: `loopbackHeaders` with `X-Hexis-Tenant`; the host honours it from loopback peers only
- [ ] 8.3 `apps/server/src/main.ts` and `shell.ts`: multi-tenant mode behind `TENANTS_FILE`; shutdown evicts every active tenant
- [ ] 8.4 Tests: runtime (activate once under concurrency, eviction stops everything, activation failure is 503 then retried), host (host to tenant, unknown host 404, loopback header only from 127.0.0.1); opt-in integration on `TEST_DATABASE_URL` with two tenants in one database
- [ ] 8.5 `docs/multi-tenant.md`, rows in `docs/configuration.md`, `.env.example`, changeset

## 9. Seat admission port (packages/core-backend) — phase 6

- [ ] 9.1 `src/core/core-ports.ts`: `accountAdmission?.canProvision(email, reason)`
- [ ] 9.2 `modules/auth/auth.service.ts`: consult it before the insert in `loginWithSso` and `createAccount`
- [ ] 9.3 Tests: refusal on SSO and on admin create; default admits
