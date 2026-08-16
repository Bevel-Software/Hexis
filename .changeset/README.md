# Changesets

The five published packages (`@bevel-software/platform-shared`, `platform-mcp-core`,
`hexis-mcp`, `platform-core-backend`, `platform-core-frontend`) form a FIXED
version group — they always release together at the same version, so the
enterprise consumer pins one version across all of them. The standalone
`apps/*` shells are private and ignored.

Flow: `pnpm changeset` (describe the change) → `pnpm changeset version`
(bumps the group + writes changelogs) → build → `pnpm changeset publish`.
