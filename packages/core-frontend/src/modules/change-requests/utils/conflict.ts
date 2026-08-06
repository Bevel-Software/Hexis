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
  // Metadata is UNTRUSTED: a crafted title (or, in principle, a crafted ref
  // name) could close its quotes and smuggle instructions into a prompt the
  // user pastes verbatim. The title is simply not needed — the number is the
  // identity — and the refs are reduced to git-ref-safe characters, which
  // cannot carry prose.
  const ref = (s: string | undefined) => (s ?? '').replace(/[^\w\-./]/g, '');
  const branch = ref(cr.branch);
  const base = ref(cr.base);
  return (
    `Change request #${cr.number} can no longer be applied: its branch ` +
    `"${branch}" conflicts with the latest "${base}". Please resolve this — merge ` +
    `"${base}" into "${branch}", resolve the conflicts so the proposed changes sit ` +
    `on top of the newer text (keep both sides' intent wherever possible), push the ` +
    `branch, and confirm change request #${cr.number} can be applied cleanly.`
  );
}
