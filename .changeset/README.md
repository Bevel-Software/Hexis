# Changesets

The five published packages (`@bevel-software/platform-shared`,
`@bevel-software/platform-mcp-core`, `@bevel-software/hexis-mcp`,
`@bevel-software/platform-core-backend`, `@bevel-software/platform-core-frontend`)
form a FIXED version group — they always release together at the same version,
so the enterprise consumer pins one version across all of them. The standalone
`apps/*` shells are private and ignored.

Flow: `pnpm changeset` (describe the change) → `pnpm changeset version`
(bumps the group + writes changelogs) → build → `pnpm changeset publish`.
