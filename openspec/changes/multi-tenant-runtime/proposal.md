## Why

Hexis is single-tenant by construction: one configuration read from the environment, one Postgres database, one workspaces folder, one knowledge-base repository, one commit-worker lease, and a handful of process-wide values (the branch model, the folder layout, the git token) that every service reads from wherever it happens to be. A cloud product is coming that serves many customer workspaces from one process, one per subdomain, with seats and plans decided outside Hexis, and an upgrade path where a customer's workspace becomes a dedicated deployment on our servers or theirs. That product cannot be built on a server that keeps "the" branch model in a module variable, writes "the" git token into its own environment, and runs every knowledge base's advisory lock under the same two integers.

## What Changes

- The server stops reading process-wide values for anything that differs per knowledge base. The branch model, the folder layout and the checkout folder name travel together as one `KbContext`, built once by the composition root and handed to every service by constructor, exactly as the checkout folder name already was. The shared package's live bindings (`DEFAULT_BRANCH`, `PLUGINS_DIR`, `currentKbLayout()` and the rest) become the browser's copy of those facts and an ESLint rule forbids them in the server packages. The shared helpers that read them take the layout or the branch model as an argument instead.
- Git credentials come from a provider injected into the git runner, which puts the token in the child process's environment; nothing writes `process.env.GITHUB_TOKEN` any more, and the setup screen's token keeps working without a restart.
- One database serves many knowledge bases, one Postgres schema each. Migrations are tracked per schema, advisory locks are keyed by the tenant, and the secrets loader that UTCP calls is keyed by the tenant too. A single-tenant deployment keeps `public` and today's lock ids.
- The server's boot side effects (the knowledge-base startup phase, the deleted-branch sweep, the join-request jobs) move out of server construction into `startCore` and `stopCore`, so a knowledge base can be brought up and torn down without starting or stopping the process.
- A tenancy module in core turns a `TenantSource` (a contract; core ships a static file-based one for development and tests) into per-tenant runtimes that the tenant host resolves by the `Host` header. Nothing below the front door knows tenants exist. Subdomain provisioning, the login redirect, seats and billing live in the cloud app, which implements the contract and fills the existing `CorePorts`.
- One new port, `accountAdmission`, is consulted before an account is created by SSO or by an admin, so the cloud app can enforce seats without forking auth.

Single-tenant Hexis, `apps/server` and the enterprise overlay keep working unchanged through every phase. Each phase is its own PR to `dev`.

## Capabilities

### New Capabilities
- `kb-context`: what one knowledge base is called on disk and in git, carried as a value the composition root builds and every service is handed; how a fresh deployment's setup-completing save applies a branch model and a layout to the running graph; what the shared package still offers the browser.
- `tenant-isolation`: what one process keeps apart per knowledge base: the database schema, the migration ledger, the advisory lock keys, the git credentials, the secrets loader.
- `tenant-host`: how one process serves several knowledge bases: the tenant source contract, the runtime lifecycle, host resolution, the loopback tenant header, eviction.
- `seat-admission`: the port the cloud app fills to admit or refuse a new account.

### Modified Capabilities

None. There are no existing specs under `openspec/specs/` for these areas.

## Impact

- **shared**: `resolveBranchModel`, `BranchModelValue`, `isProtectedBranch(model, name)`, `resolveKbLayout`, and every layout helper taking a required `layout`. The live bindings and `configureBranchModel`/`configureKbLayout` stay for the browser. Overlay code that called a helper without a layout argument must pass one.
- **core-backend**: `shared/kb-context.ts`; every service that took `kbDirName: string` takes `kb: KbContext` in that slot; `createCoreServices` builds the context and mirrors it onto the shared bindings for overlays (`CorePorts.mirrorSharedBindings`, default on); later phases add `GitCredentials`, `createDb(url, { schema })`, `startCore`/`stopCore`, `src/tenancy/*`, `CorePorts.accountAdmission`.
- **core-frontend**: passes `currentKbLayout()` / `currentBranchModel()` to the shared helpers; no behaviour change.
- **apps/server**: a multi-tenant mode behind `TENANTS_FILE` (phase 5); the single-tenant path is untouched.
- **eslint.config.js**: `no-restricted-imports` for the live bindings in `packages/core-backend/src/**` and `packages/mcp-core/src/**`, tests exempt.
- **Every deployment**: no runtime change in phase 1. Later phases: `0000_core_init.sql` loses its `public.` qualifiers, so a fresh install lands the same tables; an existing install is unaffected.
