/**
 * The default branch + the set of protected branch slugs in the KB repo, and
 * their user-visible display names. Single source of truth for BOTH sides of
 * the app, so backend enforcement and frontend affordances can never drift.
 *
 * TWO SHAPES, ONE RULE SET.
 *
 * A VALUE ({@link BranchModelValue}), resolved by {@link resolveBranchModel}
 * from the shape `/api/config` serves and the setup screen collects. The pure
 * helpers below (`isProtectedBranch`, `protectedBranchDisplayName`) take the
 * value they judge against, so a caller holding two deployments' models — a
 * server hosting several knowledge bases in one process — asks about each by
 * name. The backend uses ONLY this shape: every service is handed its
 * knowledge base's model at construction and never reads a process-wide one.
 *
 * The BROWSER'S live bindings (`DEFAULT_BRANCH`, `PROTECTED_BRANCHES`, …),
 * applied once by {@link configureBranchModel} from `GET /api/config` before
 * React renders. A page shows one deployment, so one process-wide value is
 * the right shape there, and the bindings let a component read the model
 * without threading it through props. They are for the browser: the backend
 * package forbids importing them (an ESLint rule names each one), and a
 * server that configured them would be setting a value for every knowledge
 * base it serves at once.
 *
 * Reading a live binding works inside a function body, which sees whatever
 * configuration has been applied by the time it runs. What does NOT work is
 * capturing one at module scope (`const X = DEFAULT_BRANCH` in a file's top
 * level), which snapshots the value at import — before configuration.
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

/** The shape both sides configure from, and the shape `/api/config` serves. */
export interface BranchModel {
  defaultBranch: string;
  /** Slugs; a comma/space-separated string is accepted for env convenience. */
  protectedBranches: string[] | string;
}

/**
 * A branch model as a VALUE: the resolved, validated form of {@link BranchModel}
 * that everything judging a branch is handed.
 *
 * `defaultBranch` is the branch a logged-in user lands on when they don't
 * explicitly pick one, and the default destination for shared drafts. It is
 * the empty string on the one model that is not configured yet
 * ({@link UNCONFIGURED_BRANCH_MODEL}): a fresh deployment has no branch model
 * until its setup screen is answered, and everything behind that gate reads
 * the model only once it is.
 */
export interface BranchModelValue {
  readonly defaultBranch: string;
  readonly protectedBranches: ReadonlySet<string>;
  /** Slug → human-readable name, for every protected branch. */
  readonly displayNames: Readonly<Record<string, string>>;
}

/**
 * The model a deployment has before setup has answered for one: no default
 * branch, nothing protected. {@link isBranchModelConfigured} is false for
 * exactly this value.
 */
export const UNCONFIGURED_BRANCH_MODEL: BranchModelValue = Object.freeze({
  defaultBranch: '',
  protectedBranches: new Set<string>(),
  displayNames: Object.freeze({}),
});

/**
 * Whether a model has been configured — the frontend gates render on this, and
 * the backend's setup gate keeps the app shut until it holds.
 */
export function isBranchModelConfigured(model: BranchModelValue): boolean {
  return model.defaultBranch !== '';
}

/**
 * The branch a logged-in user lands on when they don't explicitly pick one, and
 * the default destination for shared drafts. BROWSER-SIDE live binding — see
 * this file's header; the backend reads its `BranchModelValue` instead.
 *
 * Empty until {@link configureBranchModel} runs. Read it inside a function, not
 * at module scope.
 */
export let DEFAULT_BRANCH: string = '';

/** Browser-side live binding — see this file's header. */
export let PROTECTED_BRANCH_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({});

/** Browser-side live binding — see this file's header. */
export let PROTECTED_BRANCHES: ReadonlySet<string> = new Set<string>();

/**
 * Apply the branch model. Called once during boot on each side, and validated
 * here rather than at either call site so the two cannot disagree about what
 * counts as a valid pair.
 */
export function branchListOf(model: BranchModel): string[] {
  return Array.isArray(model.protectedBranches)
    ? model.protectedBranches.map((s) => s.trim()).filter(Boolean)
    : parseBranchList(model.protectedBranches);
}

/**
 * What is wrong with a pair, or null when nothing is — the same rule
 * {@link configureBranchModel} enforces, without applying anything.
 *
 * Separate because the setup screen has to VALIDATE a proposed pair before it
 * is saved, and applying a model as a side effect of checking it would swap the
 * running app onto branches nobody has confirmed yet.
 */
export function validateBranchModel(model: BranchModel): string | null {
  const defaultBranch = (model.defaultBranch ?? '').trim();
  const list = branchListOf(model);
  if (!defaultBranch) return 'A default branch is required — the branch users land on.';
  if (list.length === 0) return 'At least one protected branch is required.';
  // The default branch is where users land and the default propose target — it
  // must itself be protected, or `isProtectedBranch(DEFAULT_BRANCH)` is false
  // and the protected-branch guards silently do not apply to it. Refuse the
  // pair rather than ship that inconsistency.
  if (!list.includes(defaultBranch)) {
    return (
      `The default branch ("${defaultBranch}") must be one of the protected branches ` +
      `(${list.join(', ')}).`
    );
  }
  return null;
}

/**
 * Resolve a model into the value everything judges against. Throws on an
 * invalid pair — the same rule {@link validateBranchModel} states — so a
 * value, once held, is known to be a usable one.
 */
export function resolveBranchModel(model: BranchModel): BranchModelValue {
  const problem = validateBranchModel(model);
  if (problem) throw new Error(problem);
  const list = branchListOf(model);
  return Object.freeze({
    defaultBranch: model.defaultBranch.trim(),
    protectedBranches: new Set(list),
    displayNames: Object.freeze(Object.fromEntries(list.map((slug) => [slug, deriveDisplayName(slug)]))),
  });
}

/**
 * Apply the model to the BROWSER'S live bindings. Called once during boot,
 * from `GET /api/config`, before anything reads them. Validated by
 * {@link resolveBranchModel}, so the bindings and a value resolved from the
 * same model can never disagree.
 */
export function configureBranchModel(model: BranchModel): void {
  const value = resolveBranchModel(model);
  DEFAULT_BRANCH = value.defaultBranch;
  PROTECTED_BRANCH_DISPLAY_NAMES = value.displayNames;
  PROTECTED_BRANCHES = value.protectedBranches;
}

/**
 * The browser's model as a value — for the code paths that take a
 * {@link BranchModelValue} and run in the browser, where the one model in
 * effect is the configured one.
 */
export function currentBranchModel(): BranchModelValue {
  return {
    defaultBranch: DEFAULT_BRANCH,
    protectedBranches: PROTECTED_BRANCHES,
    displayNames: PROTECTED_BRANCH_DISPLAY_NAMES,
  };
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

/** Whether `name` is one of `model`'s protected branches. */
export function isProtectedBranch(model: BranchModelValue, name: string | null | undefined): boolean {
  return !!name && model.protectedBranches.has(name);
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
  model: BranchModelValue,
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  return Object.prototype.hasOwnProperty.call(model.displayNames, name)
    ? model.displayNames[name]!
    : null;
}
