/**
 * Builders for the chat prompts the UI dispatches when the user clicks an
 * "open a change request" affordance. The agent picks these up and runs the
 * cascade-impact + PR-creation workflow defined in `agent.instructions.ts` —
 * which is why we want the agent in the loop instead of a direct
 * `gh pr create` from the backend.
 *
 * Phrasing follows the user-facing glossary (draft, save, share, change
 * request, apply) rather than git vocabulary, since these prompts appear in
 * the chat as if the user typed them.
 */

/**
 * Sanitize a server-derived string before splicing it into an agent-facing
 * prompt. The prompts are dispatched as if the user typed them, so anything
 * that originated server-side (`recoveryDetail` from a workflow error,
 * `conflictedPaths` from a 409 payload) is in principle untrusted with
 * respect to the agent: a control character, a backtick that closes our
 * code-fence, or a 50KB rebase stderr could skew the agent's reading of
 * the request.
 *
 * Defensive transforms:
 *   - Drop ASCII control characters except `\n` and `\t`.
 *   - Replace backticks with their unicode lookalike so they can't break
 *     our code-fence delimiters in the seeded markdown.
 *   - Cap length at MAX so a verbose git stderr can't drown the
 *     surrounding instructions.
 *
 * Markdown links / asterisks aren't stripped — they may legitimately
 * appear in error messages, and the agent reads markdown anyway.
 */
const SANITIZE_MAX_CHARS = 600;

export function sanitizeForPrompt(input: string): string {
  // Strip ASCII control chars (0x00-0x1F + 0x7F) except newline + tab.
  const stripped = input.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
  // Backtick → "modifier letter grave accent" (U+02CB) — visually similar,
  // doesn't terminate fenced or inline code in our markdown.
  const detoxed = stripped.replace(/`/g, 'ˋ');
  if (detoxed.length <= SANITIZE_MAX_CHARS) return detoxed;
  return `${detoxed.slice(0, SANITIZE_MAX_CHARS)}… [truncated, ${detoxed.length - SANITIZE_MAX_CHARS} chars cut]`;
}

/**
 * Array variant: filters non-strings (defensive against malformed
 * payloads) and sanitizes each element through `sanitizeForPrompt`.
 */
function sanitizePathArrayForPrompt(input: readonly unknown[]): string[] {
  return input
    .filter((item): item is string => typeof item === 'string')
    .map((item) => sanitizeForPrompt(item));
}

export interface ProposeDraftPromptInput {
  /** The draft branch the change request should be opened from. */
  branch: string;
  /** The base (usually the protected version) the draft should land on. */
  base: string;
  /** Free-text summary of what changed (used as the PR title hint). */
  summary?: string;
  /** Optional longer description (becomes the PR body intro). */
  description?: string;
  /** Workspace-relative paths the user touched in this draft. */
  touched?: string[];
  /**
   * When true, indicates the user has already saved + shared (commit + push).
   * When false, the agent must push the draft itself before opening the PR.
   */
  alreadyShared: boolean;
}

/**
 * Seed text the chat composer receives when applying a change request hits
 * conflicts. The agent reads it as a user request to resolve the
 * disagreement and re-apply — keeping the user out of the loop. Phrased in
 * the workspace's plain-language vocabulary; the agent's system prompt
 * already knows the underlying git mechanics (which branches, which paths,
 * `commit_change` + `merge_change_request`).
 */
export function buildResolveApplyConflictsPrompt(input: {
  /** The change request number being applied. */
  changeRequestNumber: number;
  /** The base branch the CR is targeting (usually a protected branch). */
  base: string;
  /** Paths the conflict touched, if the server returned them. */
  conflictedPaths?: string[];
}): string {
  const { changeRequestNumber } = input;
  const base = sanitizeForPrompt(input.base);
  const conflictedPaths = input.conflictedPaths
    ? sanitizePathArrayForPrompt(input.conflictedPaths)
    : [];
  const pathBlurb =
    conflictedPaths.length > 0
      ? ` The files that disagree are:\n${conflictedPaths.map((p) => `- \`${p}\``).join('\n')}\n`
      : '';
  return [
    `I tried to apply change request #${changeRequestNumber} into \`${base}\` and the two sides have differences that couldn't be reconciled automatically.${pathBlurb}`,
    '',
    "Please look at each affected file, decide what the merged version should look like for the process to remain consistent, and apply your resolution to the change request's source branch. Then retry applying the change request. If you genuinely can't tell which version should win on a particular file, ask me about that specific case in plain language. But resolve everything you can on your own first.",
  ].join('\n');
}

/**
 * Seed text the chat composer receives when refreshing a change request
 * from its target (re-running the auto-merge after the target moved) hits
 * conflicts. Same shape as `buildResolveApplyConflictsPrompt` but framed
 * around "bring the latest target in" rather than "apply this draft out".
 */
export function buildResolveRefreshConflictsPrompt(input: {
  /** The change request number being refreshed. */
  changeRequestNumber: number;
  /** The base branch the CR is targeting. */
  base: string;
  /** Paths the refresh-merge conflict touched, if the server returned them. */
  conflictedPaths?: string[];
}): string {
  const { changeRequestNumber } = input;
  const base = sanitizeForPrompt(input.base);
  const conflictedPaths = input.conflictedPaths
    ? sanitizePathArrayForPrompt(input.conflictedPaths)
    : [];
  const pathBlurb =
    conflictedPaths.length > 0
      ? ` The files that disagree are:\n${conflictedPaths.map((p) => `- \`${p}\``).join('\n')}\n`
      : '';
  return [
    `I tried to bring the latest \`${base}\` into change request #${changeRequestNumber} (so the diff reflects what would actually apply now) and the two sides have differences that couldn't be reconciled automatically.${pathBlurb}`,
    '',
    "Please decide the merged version for each affected file so the change request stays coherent with the latest target, apply your resolution to the change request's source branch, then refresh again. If you can't tell which version should win on a particular file, ask me about that one case in plain language. But resolve everything you can on your own first.",
  ].join('\n');
}

export function buildProposeDraftPrompt(input: ProposeDraftPromptInput): string {
  const { branch, base, summary, description, touched, alreadyShared } = input;

  const opener = alreadyShared
    ? `I just saved and shared my draft \`${branch}\`. Please propose it as a change request that applies to \`${base}\`.`
    : `Please propose my current draft \`${branch}\` as a change request that applies to \`${base}\`. Share the draft (push) if it isn't already.`;

  const lines: string[] = [opener];

  if (summary?.trim()) {
    lines.push('', `**What I changed:** ${summary.trim()}`);
  }
  if (description?.trim()) {
    lines.push('', description.trim());
  }
  if (touched && touched.length > 0) {
    lines.push('', '**Files in this draft:**', ...touched.map((p) => `- ${p}`));
  }

  lines.push(
    '',
    'Before opening the change request, run a cascade impact analysis on the changes in this draft (per your instructions): walk the graph for any related processes, value slices, or other nodes that should also change to stay consistent, update them on this same draft, validate, and include those updates in the same change request. List the cascade in the change-request body so the reviewer can audit the ripple.',
  );

  return lines.join('\n');
}
