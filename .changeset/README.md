# Changesets

The three published packages (`@bevel-software/platform-shared`, `core-backend`,
`core-frontend`) form a FIXED version group — they always release together at
the same version, so the enterprise consumer pins one version across all
three. The standalone `apps/*` shells are private and ignored.

Flow: `pnpm changeset` (describe the change) → `pnpm changeset version`
(bumps the group + writes changelogs) → build → `pnpm changeset publish`.
