import type { PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * The exact prompt a user hands their agent when a change request can no
 * longer be applied because its branch conflicts with the target.
 *
 * Written to be COPY-PASTED VERBATIM into whatever agent the user has
 * connected, which sets its constraints: it must carry everything the agent
 * needs (the request number, both branch names — the user should not have to
 * fill in blanks), name the outcome rather than a tool sequence (agents
 * differ in what they can call), and state the resolution intent — the
 * proposal's changes belong ON TOP of the newer text, not over it.
 */
export function conflictResolutionPrompt(cr: PullRequestSummary): string {
  return (
    `Change request #${cr.number} ("${cr.title}") can no longer be applied: its branch ` +
    `"${cr.branch}" conflicts with the latest "${cr.base}". Please resolve this — merge ` +
    `"${cr.base}" into "${cr.branch}", resolve the conflicts so the proposed changes sit ` +
    `on top of the newer text (keep both sides' intent wherever possible), push the ` +
    `branch, and confirm the change request can be applied cleanly.`
  );
}
