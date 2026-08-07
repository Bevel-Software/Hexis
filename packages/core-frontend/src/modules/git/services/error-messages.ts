import { protectedBranchDisplayName } from '@bevel-software/platform-shared';
import { GitApiError } from './git.api';

/**
 * Discriminator the backend's `NoSharedHistoryError` puts in the JSON body.
 * Pinned here so the share dialog can render the agent-handoff affordance for
 * draft branches that don't share history with their target. Drift with the
 * backend literal is caught by the cross-package test that asserts both sides
 * use the same string.
 */
export const NO_SHARED_HISTORY_KIND = 'no-shared-history' as const;

/**
 * Plain-language chat prompt seeded into the composer when the user clicks
 * "Ask the assistant to resolve this" on the no-shared-history banner. Names
 * the head + base so the agent fixes the right draft (the user might have
 * several open) and steers it toward the two known recoveries — recreate
 * from the right protected branch, or rebase onto it — without prescribing
 * one over the other.
 */
export const NO_SHARED_HISTORY_RECOVERY_PROMPT = (head: string, base: string): string => {
  return [
    `My draft "${head}" can't be proposed because it doesn't share history with "${base}".`,
    'It was likely started from an unrelated point or outside the app.',
    'Please investigate which protected branch it should have been forked from,',
    'then either recreate the draft on top of that branch or rebase it onto the right starting point:',
    "whichever preserves my edits. Then I'll share the changes again.",
  ].join(' ');
};

/**
 * Structured form of a git error surfaced by the backend. The "plain" variant
 * is the non-actionable case — render the message as static text. Typed
 * variants carry the data the UI needs to render a recovery affordance.
 */
export type GitErrorInfo =
  | { kind: 'plain'; message: string }
  | { kind: typeof NO_SHARED_HISTORY_KIND; message: string; head: string; base: string };

/**
 * Parse a backend git/PR error into its structured form. Falls back to
 * `{ kind: 'plain', message }` for any error we don't have a typed mapping
 * for — same conservative contract as `friendlyGitError`.
 */
export function parseGitError(err: unknown): GitErrorInfo {
  const message = friendlyGitError(err);
  if (err instanceof GitApiError && err.body && typeof err.body === 'object') {
    const body = err.body as {
      kind?: unknown;
      head?: unknown;
      base?: unknown;
    };
    if (
      body.kind === NO_SHARED_HISTORY_KIND &&
      typeof body.head === 'string' &&
      typeof body.base === 'string' &&
      body.head.length > 0 &&
      body.base.length > 0
    ) {
      return {
        kind: NO_SHARED_HISTORY_KIND,
        message: friendlyNoSharedHistoryMessage(body.base),
        head: body.head,
        base: body.base,
      };
    }
  }
  return { kind: 'plain', message };
}

/**
 * Plain-language summary of the no-shared-history failure. Resolves the
 * protected base name to its glossary display form so the user reads
 * "Target company state" instead of `target-company-state`.
 */
function friendlyNoSharedHistoryMessage(base: string): string {
  const baseName = protectedBranchDisplayName(base) ?? base;
  return (
    `This draft doesn't share history with the ${baseName}. It was likely started ` +
    `from an unrelated point or outside the app. The assistant can investigate and ` +
    `move your edits onto the right starting point so you can share them.`
  );
}

/**
 * Map backend git/PR error messages to plain-language text for non-technical users.
 *
 * The backend errors are phrased in git vocabulary ("branch", "commit", "push") because
 * that's what the underlying CLI produces. Users never see those terms elsewhere in the
 * product, so translate at the display boundary. Unknown messages fall through to the
 * original string — it's better to show a slightly technical message than a misleading
 * one we matched by accident.
 */
export function friendlyGitError(err: unknown): string {
  // Structured typed errors carry a `kind` discriminator in the body; give
  // each one its full plain-language message here so callers that only need
  // a string (no recovery affordance) still get the friendly text.
  if (err instanceof GitApiError && err.body && typeof err.body === 'object') {
    const body = err.body as {
      kind?: unknown;
      head?: unknown;
      base?: unknown;
    };
    if (
      body.kind === NO_SHARED_HISTORY_KIND &&
      typeof body.head === 'string' &&
      typeof body.base === 'string' &&
      body.head.length > 0 &&
      body.base.length > 0
    ) {
      return friendlyNoSharedHistoryMessage(body.base);
    }
  }

  const raw = rawMessage(err);

  // Protected-branch rejections — `branch` is always quoted. Under the
  // current model the agent's writes against the official versions are NOT
  // hard-rejected on the name alone; path-level access control decides at
  // lock-acquisition. The only remaining ProtectedBranchError causes are
  // structural — you can't *create* a name that collides with an official
  // version, you can't *delete* one, and a change request *from* an
  // official version makes no sense (it IS the version). The legacy
  // "you can't save / share / undo directly, start a draft first" cases
  // are gone: those went away with the access-at-lock-time refactor, and
  // their friendlyGitError translations would only mislead the user now.
  const protectedMatch = raw.match(
    /^Branch "([^"]+)" is protected — (creating a protected branch|deleting a protected branch|opening a PR from a protected branch) is not allowed\.?$/,
  );
  if (protectedMatch) {
    const [, branch, action] = protectedMatch;
    switch (action) {
      case 'creating a protected branch':
        return `The name "${branch}" is reserved: it's an official version.`;
      case 'deleting a protected branch':
        return `"${branch}" is an official version and can't be deleted.`;
      case 'opening a PR from a protected branch':
        return `You can't propose changes from "${branch}": open the change request from a draft instead.`;
    }
  }

  // Access-control rejections (the AccessDeniedError thrown by the backend
  // when the caller lacks the `write` role on a touched path).
  const accessMatch = raw.match(
    /^You don't have permission to write to "([^"]+)"\. Eligible: (.+)\.?$/,
  );
  if (accessMatch) {
    const [, path, eligibleRaw] = accessMatch;
    // The greedy `(.+)` capture also eats the trailing `.` when the message
    // ends with one, so `eligibleRaw === 'none.'` slips past a naive equality
    // check. Strip whitespace + a single trailing period before comparing.
    const eligible = eligibleRaw.trim().replace(/\.$/, '');
    // The backend emits "Eligible: none" when both roles + users are empty at
    // the resolved path. "Restricted to none. Ask one of them…" reads as
    // nonsense, so route that case to a dedicated message that names the
    // real recovery path (contact a repo admin to broaden access).
    if (eligible === 'none') {
      return `You don't have permission to edit "${path}". Nobody currently has edit permission for this file. Contact a repo admin to grant access or broaden the rules for this folder.`;
    }
    return `You don't have permission to edit "${path}". Editing is restricted to ${eligible}. Ask one of them to make the change, or to broaden access for this folder.`;
  }

  // The legacy `DirtyWorkingTreeError` ("Uncommitted changes on X. Commit
  // before switching.") translation lived here; both the error class and
  // the source paths that emitted it (switchBranch, mergeFromOrigin) are
  // gone under save=share + per-branch workspaces, so the regex would
  // never match. Removed to keep the dispatch table honest.

  const badName = raw.match(/^Invalid branch name "([^"]+)": (.+)$/);
  if (badName) {
    return `That name isn't allowed for a draft: ${badName[2]}.`;
  }

  // Branch-authorship rejection — the caller is neither the draft's author
  // nor an admin (per `roles.yaml`). Backend `BranchAuthorshipError` keeps
  // its engineering vocabulary (`Only the author of "<name>" can delete it.`);
  // the frontend rewrites it into user-facing "draft author" + names the
  // admin escape hatch so non-authors know there's another path.
  const authorshipMatch = raw.match(/^Only the author of "([^"]+)" can delete it\.?$/);
  if (authorshipMatch) {
    return `Only the draft author or an admin can delete "${authorshipMatch[1]}". Ask them to discard it from their own picker.`;
  }

  if (raw === 'commit summary is required') return 'Please describe what you changed.';
  if (raw === 'commit summary must be ≤ 200 characters') {
    return 'Keep the description to 200 characters or less.';
  }
  if (raw === 'commit summary must be a single line') {
    return 'Keep the description on a single line.';
  }

  if (raw === 'PR title is required') return 'Please give your change request a title.';
  if (raw === 'PR title must be ≤ 256 characters') {
    return 'Keep the change request title to 256 characters or less.';
  }
  if (raw === 'PR head and base must differ') {
    return "Your draft and the version you're proposing into are the same. Nothing to request.";
  }
  if (raw.startsWith('Could not resolve a base branch for')) {
    return "Couldn't tell which official version this draft was started from. Share the draft first, then try again.";
  }
  if (/^PR not found$/i.test(raw)) {
    return "That change request no longer exists.";
  }

  // Belt-and-suspenders fallback. The backend pre-flights this in `createPr`
  // and throws a typed NoSharedHistoryError, so this regex only fires if the
  // pre-flight is bypassed and the raw GraphQL error leaks through.
  if (/has no history in common with/i.test(raw)) {
    return "This draft doesn't share history with the version you're proposing into.";
  }

  // Cancel-change-request mappings. The backend throws CancelStateError /
  // CancelAuthError with these literal messages; treat them as equality keys.
  if (raw === 'This change request was already applied.') {
    return "This change request was already applied. There's nothing to cancel.";
  }
  if (raw === 'This change request is already cancelled.') {
    return "This change request was already cancelled.";
  }
  if (/^You can't cancel this change request/.test(raw)) {
    // Already in user voice — pass through.
    return raw;
  }
  if (/^Cancel failed: /.test(raw)) {
    return "Couldn't cancel this change request right now. Try again in a moment.";
  }

  return raw;
}

function rawMessage(err: unknown): string {
  if (err instanceof GitApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

/**
 * Strip URLs, tokens, credentials, and absolute paths from an error message
 * before showing it to the user (and before logging it). Used by every auto-
 * and manual-pull surface so a raw `git pull` error with embedded
 * `https://ghp_…@host/path` or `/Users/alice/work/…` can't leak into the
 * banner / chat composer / console.
 *
 * Lives here (next to `friendlyGitError`) so the two error-shaping helpers
 * stay in one place — drift between them is the bug class this consolidation
 * exists to prevent.
 */
export function sanitizeErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return raw
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|[A-Za-z0-9_-]{32,})\b/g, '[token]')
    .replace(/\b(?:bearer|token|password|authorization)\s*[:=]\s*\S+/gi, '[token]')
    .replace(/\b[A-Za-z]:\\[^\s]+/g, '[path]')
    .replace(/\/(?:[^\s/]+\/)+[^\s/]*/g, '[path]');
}
