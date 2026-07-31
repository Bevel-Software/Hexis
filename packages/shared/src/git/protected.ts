/**
 * Authoritative, env-overridable registry of the default branch + the set of
 * protected branch slugs in the KB repo, plus their user-visible display names.
 *
 * Single source of truth for BOTH sides of the app:
 *  - Backend (Node) reads `process.env.*` at runtime — the values are populated
 *    from the environment / the `.env` loaded by `config.ts`, which runs before
 *    this module is first evaluated (see `backend/src/index.ts` import order).
 *  - Frontend (browser) can't read `process.env` at runtime, so Vite statically
 *    replaces the `process.env.DEFAULT_BRANCH` / `process.env.PROTECTED_BRANCHES`
 *    references at build time via `define` in `frontend/vite.config.ts`. Keep
 *    those references written as the literal `process.env.<NAME>` member access
 *    so the static replacement keeps matching.
 *
 * Both the backend (server-side enforcement — refusing commit/push/revert and
 * rejecting `createBranch` on protected names) and the frontend (disabling UI
 * actions, showing the protected-branch banner, branch sort order) consume this
 * single table so the two can never drift. Don't re-declare or hard-code the
 * names elsewhere.
 *
 * Env vars (both REQUIRED — no fallback; the module throws at load if either is
 * missing/empty, so a misconfigured deploy fails fast instead of silently
 * defaulting to the wrong branches). Note the frontend needs them present at
 * BUILD time (Vite `define`), the backend at runtime:
 *  - `DEFAULT_BRANCH`      — the branch a user lands on / the default propose
 *                            target.
 *  - `PROTECTED_BRANCHES`  — comma/space-separated list of protected slugs.
 *                            Display names are auto-derived from each slug
 *                            (`target-company-state` → "Target company state").
 */

// `process` is supplied by Node at runtime on the backend and statically
// replaced by Vite at build time on the frontend (vite.config.ts `define`).
// Declared locally — narrowed to just `env` — so this shared module typechecks
// without pulling @types/node into the @bevel-software/shared package. On the backend
// build (which has @types/node) this module-scoped declaration simply shadows
// the global `process`, which is harmless here.
declare const process: { env: Record<string, string | undefined> };

function parseBranchList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Human-readable name derived from a kebab/snake slug: lowercase words joined by
 * spaces with only the first letter capitalised — e.g. `target-company-state` →
 * "Target company state". Matches the historical hand-written display names.
 */
function deriveDisplayName(slug: string): string {
  const spaced = slug.replace(/[-_]+/g, ' ').trim();
  if (!spaced) return slug;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The branch a logged-in user lands on when they don't explicitly pick one, and
 * the default destination for shared drafts. Env-overridable via `DEFAULT_BRANCH`.
 */
export const DEFAULT_BRANCH: string = (process.env.DEFAULT_BRANCH ?? '').trim();
if (!DEFAULT_BRANCH) {
  throw new Error(
    'DEFAULT_BRANCH env var is required (no fallback). Set it on the backend ' +
      'runtime and at the frontend build (Vite reads it via define).',
  );
}

const PROTECTED_BRANCH_LIST: string[] = parseBranchList(process.env.PROTECTED_BRANCHES);
if (PROTECTED_BRANCH_LIST.length === 0) {
  throw new Error(
    'PROTECTED_BRANCHES env var is required (no fallback). Provide a ' +
      'comma/space-separated list of protected branch slugs.',
  );
}
// The default branch is where users land and the default propose target — it
// must itself be protected, or `isProtectedBranch(DEFAULT_BRANCH)` is false and
// the protected-branch guards silently don't apply to it. Fail fast on a
// misconfigured pair rather than shipping that inconsistency.
if (!PROTECTED_BRANCH_LIST.includes(DEFAULT_BRANCH)) {
  throw new Error(
    `DEFAULT_BRANCH ("${DEFAULT_BRANCH}") must be one of PROTECTED_BRANCHES ` +
      `(${PROTECTED_BRANCH_LIST.join(', ')}).`,
  );
}

export const PROTECTED_BRANCH_DISPLAY_NAMES: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      PROTECTED_BRANCH_LIST.map((slug) => [slug, deriveDisplayName(slug)]),
    ),
  );

export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(PROTECTED_BRANCH_LIST);

export function isProtectedBranch(name: string | null | undefined): boolean {
  return !!name && Object.prototype.hasOwnProperty.call(
    PROTECTED_BRANCH_DISPLAY_NAMES,
    name,
  );
}

/**
 * Capitalised, human-readable name for a protected branch — e.g.
 * `current-company-state` → "Current company state".
 *
 * Use this everywhere the branch name appears in user-visible body copy
 * (banners, tooltips, button labels). The raw kebab slug is fine in small
 * monospace badges for power users / debug surfaces, but body copy should
 * never read "merge into current-company-state" to a non-developer.
 *
 * Returns `null` for unknown / non-protected names so the caller can decide
 * whether to fall back to the raw string or hide the affordance.
 */
export function protectedBranchDisplayName(
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  return PROTECTED_BRANCH_DISPLAY_NAMES[name] ?? null;
}
