import {
  DEFAULT_BRANCH,
  branchSegment,
  suggestionsBranchPrefixFor,
  type PullRequestSummary,
} from '@bevel-software/platform-shared';
import { createBranch, deleteBranch } from '../../git/services/git.api';
import { getOrCreateWorkspace, writeFile } from '../../workspace/services/workspace.api';
import { openChangeRequest } from '../../pr/services/pr-open.api';
import { listMyChangeRequests } from './change-requests.api';

/** The default branch's workspace id (id = encodeURIComponent(branch)), read lazily. */
const defaultWorkspaceId = () => encodeURIComponent(DEFAULT_BRANCH);

// The segment cleaner lives in `@bevel-software/platform-shared` now — the
// server judges "may this caller delete this suggestions branch?" from the
// same naming, and the two sides must never disagree. Re-exported for the
// library's per-skill branch naming.
export { branchSegment };

/** The identity a proposal is filed under — enough to name its branch. */
export interface ProposalAuthor {
  email: string;
  /** The stable user id — what makes the branch name collision-proof. */
  id: string;
}

/**
 * The one personal suggestions branch bundling ALL of a user's Knowledge
 * proposals. Skills keep their per-skill branches (a skill is one decision);
 * the knowledge folder gets one branch and one change request per person, so
 * every edit a reader proposes lands in the same reviewable bundle.
 *
 * The email's local part alone is NOT the identity: `branchSegment` is lossy
 * (`alex+ops@…` and `alex-ops@…` both clean to `alex-ops`), and two users
 * mapping to one branch means one can silently rewrite the other's pending
 * proposal. A slice of the stable user id disambiguates; the local part stays
 * for the human reading the branch list.
 */
export function knowledgeSuggestionBranchFor(user: ProposalAuthor): string {
  return `${suggestionsBranchPrefixFor(user)}knowledge`;
}

export interface ProposeKnowledgeChangeInput {
  /** Repo-root-relative path of the file being proposed on (no kbDirName prefix). */
  repoRelativePath: string;
  /** The file's full new text — what the author typed in the editor. */
  content: string;
  userEmail: string;
  /** Stable user id — see {@link knowledgeSuggestionBranchFor}. */
  userId: string;
  userName: string;
}

/**
 * Propose a change to a Knowledge file: commit the new text to the author's
 * personal suggestions branch (forked from the default branch) and make sure
 * an open change request against the default branch exists for it.
 *
 * Save = share: `writeFile` on the branch workspace auto-commits and pushes,
 * so the proposal survives the tab closing the moment this resolves. The
 * existing-request lookup is by BRANCH against the caller's own requests —
 * `touchedNodePaths` is empty until computed, so a path-derived check would
 * open a second request against the branch that already has one.
 */
export async function proposeKnowledgeChange(
  input: ProposeKnowledgeChangeInput,
): Promise<{ branch: string }> {
  const target = await ensureKnowledgeSuggestionWorkspace({
    email: input.userEmail,
    id: input.userId,
  });
  await writeFile(
    target.workspaceId,
    `${target.kbDirName}/${input.repoRelativePath}`,
    input.content,
  );
  await ensureKnowledgeChangeRequest(target, input.userName);
  return { branch: target.branch };
}

/**
 * The caller's personal suggestions workspace, ready to be written to.
 * Splitting the propose flow in two lets writes of ANY shape ride it — a
 * typed proposal writes one file between these calls, an upload into a folder
 * the caller may not write streams many.
 */
export interface KnowledgeSuggestionTarget {
  branch: string;
  workspaceId: string;
  kbDirName: string;
  /** The caller's open request on this branch, or null when the write must open one. */
  existingCr: PullRequestSummary | null;
}

export async function ensureKnowledgeSuggestionWorkspace(
  user: ProposalAuthor,
): Promise<KnowledgeSuggestionTarget> {
  const branch = knowledgeSuggestionBranchFor(user);

  // FRESH, not the 30s cache: a second proposal inside the cache window must
  // see the request the first one just opened, or it opens a duplicate
  // against the same branch.
  const mine = await listMyChangeRequests({ fresh: true });
  const existingCr = mine.find((c) => c.state === 'open' && c.branch === branch) ?? null;

  if (!existingCr) {
    try {
      await createBranch(defaultWorkspaceId(), branch, DEFAULT_BRANCH);
    } catch {
      // The branch already exists — a leftover from a withdrawn round, or a
      // merge whose retirement failed. Its old commits would ride into the
      // next request, so TRY a reset: delete the branch (the server also
      // retires its stale workspace clone) and recreate it fresh from the
      // default branch. The server recognises `suggestions/<who>-<id>/…` as
      // the caller's own, so this needs no admin role.
      try {
        await deleteBranch(defaultWorkspaceId(), branch);
        await createBranch(defaultWorkspaceId(), branch, DEFAULT_BRANCH);
      } catch {
        // Strictly best-effort: on any refusal (authorship, network, a race
        // with a concurrent proposal) fall back to plain reuse — the change
        // request is what makes the branch reviewable either way.
      }
    }
  }

  const { workspace } = await getOrCreateWorkspace(branch);
  return { branch, workspaceId: workspace.id, kbDirName: workspace.kbDirName, existingCr };
}

/**
 * Open the caller's one Knowledge change request, unless it already exists.
 * Returns the request either way (the server's created row, or the existing
 * one) so callers can announce it — the optimistic suggestion rows need its
 * number and branch the moment the write lands.
 */
export async function ensureKnowledgeChangeRequest(
  target: KnowledgeSuggestionTarget,
  userName: string,
): Promise<PullRequestSummary | null> {
  if (target.existingCr) return target.existingCr;
  const created = await openChangeRequest({
    sourceBranch: target.branch,
    targetBranch: DEFAULT_BRANCH,
    title: `Changes from ${userName} — Knowledge`,
  });
  // The endpoint returns the created request; treat an unexpected shape as
  // "no summary to announce" rather than a failure — the request exists.
  return created && typeof (created as PullRequestSummary).number === 'number'
    ? (created as PullRequestSummary)
    : null;
}
