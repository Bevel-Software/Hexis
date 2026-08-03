# @bevel-software/platform-core-backend

## 0.2.1

### Patch Changes

- Ports the enterprise `dev`-branch `execute_command` fixes into the core (they landed upstream in files this package now owns): internal tokens can carry a `focusedBranch` claim, surfaced as `ToolContext.focusedBranch`, and a branch-less `execute_command` from an internal session falls back to it (external callers still fail closed with 400); the literal strings `"undefined"`/`"null"` are rejected by name as `branch` values ahead of the canonical shape validator, closing the clone-a-branch-named-"undefined" production 500.
  - @bevel-software/platform-shared@0.2.1

## 0.2.0

### Minor Changes

- 14c79f5: Auth overhaul: per-user password accounts (scrypt, `users.password_hash`, core migration 0001), env bootstrap admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD`, replaces the shared `TEST_PASSWORD`), admin account management (`/api/admin/accounts` + the Accounts section on Roles & Members), self-service password change (`/api/auth/change-password` + the `/account` page), and a generic env-configured OIDC SSO provider. BREAKING for overlays: `AuthProviderPlugin` now requires `label` + `startPath`, `GET /api/auth/providers` returns `{ password, sso: [...] }`, `loginWithMicrosoft` is renamed `loginWithSso`, and the frontend `microsoft-oauth.ts` service is generalized to `sso.ts`.

### Patch Changes

- Updated dependencies [14c79f5]
  - @bevel-software/platform-shared@0.2.0

## 0.2.0-auth.0

### Minor Changes

- Auth overhaul: per-user password accounts (scrypt, `users.password_hash`, core migration 0001), env bootstrap admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD`, replaces the shared `TEST_PASSWORD`), admin account management (`/api/admin/accounts` + the Accounts section on Roles & Members), self-service password change (`/api/auth/change-password` + the `/account` page), and a generic env-configured OIDC SSO provider. BREAKING for overlays: `AuthProviderPlugin` now requires `label` + `startPath`, `GET /api/auth/providers` returns `{ password, sso: [...] }`, `loginWithMicrosoft` is renamed `loginWithSso`, and the frontend `microsoft-oauth.ts` service is generalized to `sso.ts`.

### Patch Changes

- Updated dependencies
  - @bevel-software/platform-shared@0.2.0-auth.0

## 0.1.1

### Patch Changes

- Internal (loopback) tool tokens are now signed with a STABLE key — `INTERNAL_TOKEN_SECRET`, or a domain-separated key derived from `JWT_SECRET` — instead of a per-boot random secret. A sibling process sharing the deployment env (a routine CLI, a second replica) now mints tokens the server verifies, so its agents can discover tools over the loopback surface. Single-process behavior is unchanged; deployments with no `JWT_SECRET` keep the per-boot random key.
  - @bevel-software/platform-shared@0.1.1
