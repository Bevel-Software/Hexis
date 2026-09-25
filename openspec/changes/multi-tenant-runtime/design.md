## Context

`createCoreServices(config, ports)` builds one graph of services from one `CoreConfig`; `createCoreServer(core, ext)` wraps it in one Express app and, as a side effect, runs the knowledge-base startup phase and starts the sweeps. The enterprise overlay calls the same two functions with its own `AppConfig extends CoreConfig`, its own `CorePorts` and `ServerExtensions`. That composition root is the seam the multi-tenant runtime builds on: a tenant is one call of each, with a per-tenant config, and a front door that picks the graph by `Host`.

What stood in the way was process-global state. The inventory (2026-09-24):

| Global | Where | Fix |
|---|---|---|
| `DEFAULT_BRANCH`, `PROTECTED_BRANCHES`, `PROTECTED_BRANCH_DISPLAY_NAMES` live bindings | `packages/shared/src/git/protected.ts`, read by 54 server files | `BranchModelValue` by constructor (phase 1) |
| `KNOWLEDGE_BASE_DIR`, `SKILLS_DIR`, `PLUGINS_DIR`, `AGENTS_FILE`, `currentKbLayout()`, `onKbLayoutApplied` | `packages/shared/src/workspace/kb-layout.ts`, `platform-files.ts` | `KbLayout` by constructor; helpers take a required `layout` (phase 1) |
| `process.env.GITHUB_TOKEN` written at boot and by the setup screen, read in six places | `core-config.ts`, `deployment-settings.service.ts`, `git.contract.ts`, `redact-secret.ts`, `clone-config.ts`, `workspace.service.ts`, `workflow.service.ts`, `review-workflow.service.ts` | `GitCredentials` provider injected into `NodeGitRunner` (phase 2) |
| `getDb` singleton | `modules/database/connection.ts` | `createDb(url, { schema })`, cache keyed by url and schema (phase 3) |
| Advisory lock ids `(HEXI, 1 or 3)` are database-wide | `modules/database/advisory-lock.ts` | second int `lock ^ crc32(tenantKey)`; empty key keeps today's ids (phase 3) |
| `sharedSecretsVault` static for the UTCP `bevel_secrets` loader | `secrets-vault/secrets-variable-loader.ts` | map keyed by tenant (phase 3) |
| `'public.<table>'::regclass` guards | `migrations/0000_core_init.sql`, 7 lines | `to_regclass('<table>')` (phase 3) |
| Boot side effects inside `createCoreServer` | `core/create-core-server.ts` | `startCore` / `stopCore` (phase 4) |
| Loopback `http://127.0.0.1:port` carries no tenant | `mcp/mcp.service.ts` | `X-Hexis-Tenant` header, honoured only from loopback peers (phase 5) |

Everything else (caches, event bus, notifier, rate limiters, tool registry, settings service, OAuth AS, mutexes) is already per instance.

Decisions taken with Razvan on 2026-09-24: in-process tenant runtimes over shared tables with a `tenant_id` column; schema per tenant in one database; the contract in core and the registry in the cloud app; explicit constructor injection over `AsyncLocalStorage`.

```text
                 TenantSource (cloud app; StaticTenantSource in core)
                              |
                   resolveByHost(host) -> TenantDescriptor
                              |
        createTenantHost ------+------ TenantRuntime (idle -> activating -> active -> evicting)
              |                                |
        Host header  ---->  activate(): CREATE SCHEMA, createCoreServices(config, ports),
        X-Hexis-Tenant                  startCore(core, ext), createCoreServer(core, ext)
        (loopback only)                 evict():  stopCore(core), pool.end()
              |                                |
        tenant's Express app  <---- one KbContext, one pool (search_path), one workspaces root
```

## Goals / Non-Goals

**Goals:**
- One process serves many knowledge bases, each with its own branch model, layout, repository, credentials, database schema and workspaces folder, and none of them can read another's.
- Single-tenant Hexis and the enterprise overlay keep their composition root, their config class and their behaviour through every phase.
- Every per-knowledge-base value reaches a service the same way `kbDirName` always did: by constructor. No request-scoped magic.
- A tenant's data leaves as a `pg_dump -n <schema>` plus a copy of its workspaces folder and boots as a dedicated deployment.
- The cloud app needs no fork: a `TenantSource`, the existing `CorePorts`/`ServerExtensions` per tenant, and one admission port for seats.

**Non-Goals:**
- Subdomain provisioning, DNS, the root-domain "find your workspace" login redirect, plans, seat counts, an operator UI: all cloud app.
- Connection pooling past a few hundred active tenants (PgBouncer sizing) and cross-tenant reporting.
- A database-backed tenant registry in core. Core ships the contract and a static file source.

## Decisions

**1. In-process tenant runtimes, resolved by `Host`.**
A tenant is one `CoreServices` graph plus one Express app, built by the unchanged composition root with a per-tenant config. Everything the enterprise overlay does per deployment (SSO plugin, session sink, erasure participants) it can do per tenant through the same `CorePorts` and `ServerExtensions`. Alternative considered: shared tables with a `tenant_id` column and a request-scoped context. Rejected because every query, cache key, lock, file path and background job would need the discriminator threaded through, and a single missed site is a cross-tenant leak that no type checks; per-instance graphs make the mistake impossible rather than merely unlikely.

**2. Schema per tenant in one database.**
One pool per tenant with `options=-c search_path=<schema>`, a per-schema `__drizzle_migrations_core` ledger, `CREATE SCHEMA IF NOT EXISTS t_<slug>` at activation. Isolation is a Postgres object, export is one `pg_dump` flag, and single-tenant keeps `public` with no migration. Alternative: a database per tenant. Rejected for now because pools and connection limits scale per database, and `CREATE DATABASE` needs a superuser role the app should not hold.

**3. `KbContext` by constructor; the live bindings become browser-only.**
`KbContext { kbDirName, branchModel, layout }` is built once in `createCoreServices` from the deployment settings and passed in the slot where `kbDirName: string` was, so the call sites change shape but not position. Its getters are live: a fresh deployment has no branch model until the setup screen is answered, and the save that completes setup calls `applyBranchModel` / `applyLayout` on the running graph so the knowledge-base phase in that same request already scaffolds the admin's names. Listeners exist for the two things that cannot read the context at use time (tool descriptions validated into frozen defs at registration; the overlay mirror). An ESLint `no-restricted-imports` rule names every live binding for the server packages, tests exempt, so a regression fails lint rather than review. `createCoreServices` keeps one permitted site, `mirrorSharedBindings`, so an overlay that still reads a binding sees the single-tenant value; a multi-tenant host turns the mirror off. Alternative: `AsyncLocalStorage` carrying the tenant. Rejected with the user: implicit, lost across `setTimeout` and event emitters, invisible to tests.

**4. Pure shared helpers with a required layout.**
`isPlatformFile(path, layout)`, `reservedRootDirNames(layout)`, `renderKbLayoutPlaceholders(text, layout)` and the rest take the layout they are asked about. The browser passes `currentKbLayout()`; the server passes `kb.layout`. A default argument would have hidden a process-wide read behind a call that looks pure, which is the bug this change removes.

**5. Git credentials as a provider on the runner.**
`GitCredentials { username(); token() }` is handed to `NodeGitRunner`, which sets `GITHUB_TOKEN` in the child's environment only; the credential helper snippet that reads `$GITHUB_TOKEN` is unchanged and the token never reaches argv. The provider reads the settings service, so a token saved on the setup screen is in effect on the next git call without a restart. Redaction takes the tokens to scrub from the caller.

**6. Advisory locks keyed by tenant.**
`lock ^ crc32(tenantKey)` for the second integer, unchanged when the key is empty. A collision between two tenants only serialises them against each other; it cannot let two workers of one tenant run at once.

**7. `startCore` / `stopCore`.**
The startup phase with its unreachable-remote retry, the deleted-branch sweep and the join-request jobs move out of `createCoreServer` into `startCore(core, ext)`; `stopCore(core)` is the existing shutdown sequence minus closing the HTTP server and exiting. `createCoreServer` and `createShutdown` keep their signatures and call them, so nothing outside core changes. Every timer in the graph must be per request, per instance, or stopped by `stopCore`.

**8. Tenant host, lifecycle and loopback.**
`createTenantHost({ source, process, staticDir })` returns the app the process listens on: it resolves `req.hostname` to a `TenantRuntime`, activates it on first use under one in-flight promise (requests arriving during activation wait, bounded; past the bound 503 with `Retry-After`), hands the request to the tenant's app, serves the SPA once for every resolved tenant, answers `/api/health` at the host level and leaves `/api/ready` per tenant. Unknown host: 404 JSON under `/api`, a plain page otherwise. Idle tenants are evicted after N minutes without a request unless they hold a lease or queued commits. Loopback calls the MCP proxy makes into its own tenant carry `X-Hexis-Tenant: <slug>`; the host honours the header only when the socket peer is loopback.

**9. Per-tenant secrets by derivation.**
The static source derives `jwtSecret`, `secretsEncKey` and `internalTokenSecret` per tenant with HKDF-SHA256 from `TENANT_MASTER_KEY` and the slug, in `tenant-secrets.ts`, so the cloud app can reuse it and an exported tenant's keys are reproducible for the enterprise hand-over.

**10. One admission port.**
`CorePorts.accountAdmission.canProvision(email, reason)` runs before the insert in `loginWithSso` and `createAccount`; core admits everyone. The one hook the cloud app needs for seats without forking auth.

## Risks / Trade-offs

- **Call-site churn in phase 1.** About 54 production files and 120 test files change a constructor argument. Mitigation: the argument keeps its slot, `kbDirName` stays reachable as `kb.kbDirName`, and a `testKbContext()` fixture gives every suite the historical two-branch pair and the default layout in one call.
- **Overlay code that reads a live binding.** The mirror keeps single-tenant overlays working; the ESLint rule applies only to this repository. Documented in the changeset so the enterprise repin passes a layout where it calls a shared helper.
- **Advisory lock collisions.** Over-serialisation only; never under-locking.
- **Activation storms.** Many tenants first-requested at once each clone a repository and run migrations. Bounded by the in-flight promise per tenant and the 503 past the wait bound; sizing beyond that is the cloud app's concern.
- **The setup-completing save mutates a live value.** This is the single-tenant behaviour today, moved from a module variable onto the graph's own context. In multi-tenant mode the runtime can instead re-activate the tenant after a completing save; decided per site in phase 5.

## Migration Plan

Six PRs to `dev`, single-tenant green after each: (1) OpenSpec change, shared pure API, `KbContext` through the server, ESLint rule; (2) git credentials provider; (3) database per schema, config split, secrets loader; (4) lifecycle split; (5) tenancy module, host, `apps/server` multi mode, docs, e2e; (6) seat admission port. No data migration: existing installs stay on `public` with today's lock ids; the init migration's `public.` qualifiers are dropped only for fresh schemas.

## Open Questions

- Whether a completing setup save in multi-tenant mode re-activates the tenant (evict + activate) or applies to the live context as single-tenant does. Leaning re-activate: it is the mechanism that already exists, and a tenant that just answered its setup screen has no traffic to interrupt.
- Idle eviction default (minutes) and the activation wait bound (seconds). To be set with the first load test in phase 5.
