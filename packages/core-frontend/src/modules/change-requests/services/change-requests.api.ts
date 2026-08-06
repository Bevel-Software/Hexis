import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';
import { getOrCreateWorkspace, readFile } from '../../workspace/services/workspace.api';

/**
 * The change-request module's data access — the reads every review surface
 * shares. The Library's skill pages and the Knowledge viewer both build their
 * boxes, diffs and suggestion overlays from these three calls; they live here
 * so neither surface has to import the other's service layer.
 */

/**
 * All open change requests (callers filter to a folder or a file).
 * `opts.fresh` bypasses the backend's 30s list cache — for event-driven
 * refreshes that KNOW the list just changed, where a cached answer would
 * hide the very change that triggered them.
 */
export async function listOpenChangeRequests(
  opts: { fresh?: boolean } = {},
): Promise<PullRequestSummary[]> {
  return handleApiResponse<PullRequestSummary[]>(
    await authFetch(`/api/workflow/change-requests${opts.fresh ? '?fresh=1' : ''}`),
  );
}

/**
 * The caller's own change requests (any state; callers filter to open). The
 * identity filter lives server-side — an email-hash match — which is the only
 * place it can: the broad list deliberately exposes no email to compare
 * against. Same `fresh` contract as above.
 */
export async function listMyChangeRequests(
  opts: { fresh?: boolean } = {},
): Promise<PullRequestSummary[]> {
  return handleApiResponse<PullRequestSummary[]>(
    await authFetch(`/api/workflow/change-requests/mine${opts.fresh ? '?fresh=1' : ''}`),
  );
}

/** Read a file from a branch's shared workspace (bootstraps the clone if needed). */
export async function readFileOnBranch(branch: string, repoRelativePath: string): Promise<string> {
  const { workspace } = await getOrCreateWorkspace(branch);
  return readFile(workspace.id, `${workspace.kbDirName}/${repoRelativePath}`);
}
