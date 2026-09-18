import {
  DEFAULT_BRANCH,
  branchSegment,
  suggestionsBranchPrefixFor,
  type PullRequestSummary,
} from '@bevel-software/platform-shared';
import { createBranch, deleteBranch, GitApiError } from '../../git/services/git.api';
import { getOrCreateWorkspace, writeFile } from '../../workspace/services/workspace.api';
import { openChangeRequest } from '../../pr/services/pr-open.api';
import { fetchPrDetail } from '../../pr/services/pr-detail.api';
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

/**
 * The workspace ensure in flight for a branch — same in-flight-only contract
 * as {@link openingByBranch}. Two proposals started together would otherwise
 * each pay the fresh list read (the slow call), each try to create the same
 * branch, and each reach the same conclusion; one answer serves both.
 */
const ensuringByBranch = new Map<string, Promise<KnowledgeSuggestionTarget>>();

export function ensureKnowledgeSuggestionWorkspace(
  user: ProposalAuthor,
): Promise<KnowledgeSuggestionTarget> {
  const branch = knowledgeSuggestionBranchFor(user);
  const inFlight = ensuringByBranch.get(branch);
  if (inFlight) return inFlight;
  const ensuring = ensureFresh(branch).finally(() => {
    if (ensuringByBranch.get(branch) === ensuring) ensuringByBranch.delete(branch);
  });
  ensuringByBranch.set(branch, ensuring);
  return ensuring;
}

async function ensureFresh(branch: string): Promise<KnowledgeSuggestionTarget> {
  // FRESH, not the 30s cache: a second proposal inside the cache window must
  // see the request the first one just opened, or it opens a duplicate
  // against the same branch.
  const mine = await listMyChangeRequests({ fresh: true });
  const existingCr = mine.find((c) => c.state === 'open' && c.branch === branch) ?? null;

  if (!existingCr) {
    try {
      await createBranch(defaultWorkspaceId(), branch, DEFAULT_BRANCH);
    } catch (err) {
      // ONLY an already-exists refusal is evidence of a leftover branch (a
      // withdrawn round, a merge whose retirement failed) worth resetting —
      // a transient failure is not, and "delete on any error" could tear
      // down a branch the failure said nothing about. The server refuses the
      // delete outright while the branch carries an open request, so a race
      // with a concurrent proposal cannot wipe an active branch either.
      const alreadyExists =
        err instanceof Error && /already exists/i.test(err.message);
      if (alreadyExists) {
        // TRY a reset: delete the leftover (the server also retires its
        // stale workspace clone) and recreate fresh from the default branch.
        // The server recognises `suggestions/<who>-<id>/…` as the caller's
        // own, so this needs no admin role.
        try {
          await deleteBranch(defaultWorkspaceId(), branch);
          await createBranch(defaultWorkspaceId(), branch, DEFAULT_BRANCH);
        } catch {
          // Strictly best-effort: on any refusal fall back to plain reuse —
          // the change request is what makes the branch reviewable either way.
        }
      }
      // Non-exists failures fall through to the write below, which surfaces
      // anything real with its own error.
    }
  }

  const { workspace } = await getOrCreateWorkspace(branch);
  return { branch, workspaceId: workspace.id, kbDirName: workspace.kbDirName, existingCr };
}

/**
 * The number of the open request the server says already covers this
 * (source, target) pair, or null when the failure was anything else. The
 * refusal carries the number precisely so a client can reach the request
 * instead of treating the state as broken (`DuplicateChangeRequestError`).
 */
function duplicateRequestNumber(err: unknown): number | null {
  if (!(err instanceof GitApiError) || err.status !== 409) return null;
  const body = err.body as { kind?: unknown; existingNumber?: unknown } | null | undefined;
  if (!body || typeof body !== 'object' || body.kind !== 'duplicate-change-request') return null;
  return typeof body.existingNumber === 'number' ? body.existingNumber : null;
}

/**
 * The open request being made for a branch right now, so a second proposal
 * joins it instead of racing it. In-flight ONLY, never a cache: whether the
 * caller still has an open request is the server's answer to give, and a
 * withdrawn or merged one must not be remembered here.
 */
const openingByBranch = new Map<string, Promise<PullRequestSummary | null>>();

/**
 * Open the caller's one Knowledge change request, unless it already exists.
 * Returns the request either way (the server's created row, or the existing
 * one) so callers can announce it — the optimistic suggestion rows need its
 * number and branch the moment the write lands.
 *
 * Two proposals started before either had opened the request both read
 * `existingCr: null` from `ensureKnowledgeSuggestionWorkspace`, and the
 * second one used to fail the whole proposal on the server's
 * one-open-request-per-pair refusal — a 409 the user saw as "Couldn't add
 * change request". The window is exactly how long the fresh list read takes,
 * which grows with the number of open requests, so "propose again while the
 * first is still loading" hit it reliably. Both halves are closed here:
 *
 *  - concurrently, the second call JOINS the first's open rather than issuing
 *    its own, so there is only ever one request in flight per branch; and
 *  - sequentially — or from another tab, or another device, where no
 *    client-side coordination can help — the duplicate refusal is read for
 *    what it is. It names the request that already exists, which is the state
 *    this function is trying to reach, so it adopts it instead of failing.
 */
export function ensureKnowledgeChangeRequest(
  target: KnowledgeSuggestionTarget,
  userName: string,
): Promise<PullRequestSummary | null> {
  if (target.existingCr) return Promise.resolve(target.existingCr);
  const inFlight = openingByBranch.get(target.branch);
  if (inFlight) return inFlight;
  const opening = openKnowledgeChangeRequest(target, userName).finally(() => {
    if (openingByBranch.get(target.branch) === opening) openingByBranch.delete(target.branch);
  });
  openingByBranch.set(target.branch, opening);
  return opening;
}

async function openKnowledgeChangeRequest(
  target: KnowledgeSuggestionTarget,
  userName: string,
): Promise<PullRequestSummary | null> {
  let created: unknown;
  try {
    created = await openChangeRequest({
      sourceBranch: target.branch,
      targetBranch: DEFAULT_BRANCH,
      title: `Changes from ${userName}. Knowledge`,
    });
  } catch (err) {
    const existing = duplicateRequestNumber(err);
    // Anything else is a real failure and stays one — the caller reports it.
    if (existing === null) throw err;
    // The request exists; read it so the caller can still announce its rows.
    // A failed read is only a missing announcement, never a failed proposal:
    // the bytes are committed and the request is open either way.
    return await fetchPrDetail(existing, { fresh: true }).catch(() => null);
  }
  // The endpoint returns the created request; treat an unexpected shape as
  // "no summary to announce" rather than a failure — the request exists.
  return created && typeof (created as PullRequestSummary).number === 'number'
    ? (created as PullRequestSummary)
    : null;
}
