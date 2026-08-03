# @bevel-software/platform-core-frontend

## 0.2.0-auth.0

### Minor Changes

- Auth overhaul: per-user password accounts (scrypt, `users.password_hash`, core migration 0001), env bootstrap admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD`, replaces the shared `TEST_PASSWORD`), admin account management (`/api/admin/accounts` + the Accounts section on Roles & Members), self-service password change (`/api/auth/change-password` + the `/account` page), and a generic env-configured OIDC SSO provider. BREAKING for overlays: `AuthProviderPlugin` now requires `label` + `startPath`, `GET /api/auth/providers` returns `{ password, sso: [...] }`, `loginWithMicrosoft` is renamed `loginWithSso`, and the frontend `microsoft-oauth.ts` service is generalized to `sso.ts`.

### Patch Changes

- Updated dependencies
  - @bevel-software/platform-shared@0.2.0-auth.0

## 0.1.1

### Patch Changes

- @bevel-software/platform-shared@0.1.1
