/**
 * The default branch + the set of protected branch slugs in the KB repo, and
 * their user-visible display names. Single source of truth for BOTH sides of
 * the app, so backend enforcement and frontend affordances can never drift.
 *
 * CONFIGURED, NOT IMPORTED. This module used to read `process.env` at import
 * time and throw when it found nothing — which made the branch model something
 * a deployment had to know before any code could load. On the frontend that
 * meant baking it into the bundle at build time (Vite `define`), so the same
 * artifact could not serve two deployments and changing a branch name meant a
 * rebuild. Both sides now CALL {@link configureBranchModel} during boot:
 * the backend from its environment, the browser from `GET /api/config`.
 *
 * The exported bindings stay bindings — `DEFAULT_BRANCH` is still imported and
 * read exactly as before at every call site. ES module live bindings mean a
 * reader inside a function body sees whatever configuration has been applied by
 * the time it runs. What does NOT work is capturing one at module scope
 * (`const X = DEFAULT_BRANCH` in a file's top level), which snapshots the value
 * at import — before configuration. Use a function there instead.
 */

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
 * the default destination for shared drafts.
 *
 * Empty until {@link configureBranchModel} runs. Read it inside a function, not
 * at module scope — see this file's header.
 */
export let DEFAULT_BRANCH: string = '';

export let PROTECTED_BRANCH_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({});

export let PROTECTED_BRANCHES: ReadonlySet<string> = new Set<string>();

/** The shape both sides configure from, and the shape `/api/config` serves. */
export interface BranchModel {
  defaultBranch: string;
  /** Slugs; a comma/space-separated string is accepted for env convenience. */
  protectedBranches: string[] | string;
}

/**
 * Apply the branch model. Called once during boot on each side, and validated
 * here rather than at either call site so the two cannot disagree about what
 * counts as a valid pair.
 */
export function configureBranchModel(model: BranchModel): void {
  const defaultBranch = (model.defaultBranch ?? '').trim();
  const list = Array.isArray(model.protectedBranches)
    ? model.protectedBranches.map((s) => s.trim()).filter(Boolean)
    : parseBranchList(model.protectedBranches);

  if (!defaultBranch) {
    throw new Error('A default branch is required — the branch users land on.');
  }
  if (list.length === 0) {
    throw new Error('At least one protected branch is required.');
  }
  // The default branch is where users land and the default propose target — it
  // must itself be protected, or `isProtectedBranch(DEFAULT_BRANCH)` is false
  // and the protected-branch guards silently do not apply to it. Refuse the
  // pair rather than ship that inconsistency.
  if (!list.includes(defaultBranch)) {
    throw new Error(
      `The default branch ("${defaultBranch}") must be one of the protected branches ` +
        `(${list.join(', ')}).`,
    );
  }

  DEFAULT_BRANCH = defaultBranch;
  PROTECTED_BRANCH_DISPLAY_NAMES = Object.freeze(
    Object.fromEntries(list.map((slug) => [slug, deriveDisplayName(slug)])),
  );
  PROTECTED_BRANCHES = new Set(list);
}

/** Whether {@link configureBranchModel} has run — the frontend gates render on this. */
export function isBranchModelConfigured(): boolean {
  return DEFAULT_BRANCH !== '';
}

/**
 * The model as the environment describes it. Node-side only; the browser has no
 * `process.env` to read and is served the same shape by `GET /api/config`.
 */
export function branchModelFromEnv(): BranchModel {
  return {
    defaultBranch: (process.env.DEFAULT_BRANCH ?? '').trim(),
    protectedBranches: process.env.PROTECTED_BRANCHES ?? '',
  };
}

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
