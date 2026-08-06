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

/** All open change requests (callers filter to a folder or a file). */
export async function listOpenChangeRequests(): Promise<PullRequestSummary[]> {
  return handleApiResponse<PullRequestSummary[]>(
    await authFetch('/api/workflow/change-requests'),
  );
}

/**
 * The caller's own change requests (any state; callers filter to open). The
 * identity filter lives server-side — an email-hash match — which is the only
 * place it can: the broad list deliberately exposes no email to compare
 * against.
 */
export async function listMyChangeRequests(): Promise<PullRequestSummary[]> {
  return handleApiResponse<PullRequestSummary[]>(
    await authFetch('/api/workflow/change-requests/mine'),
  );
}

/** Read a file from a branch's shared workspace (bootstraps the clone if needed). */
export async function readFileOnBranch(branch: string, repoRelativePath: string): Promise<string> {
  const { workspace } = await getOrCreateWorkspace(branch);
  return readFile(workspace.id, `${workspace.kbDirName}/${repoRelativePath}`);
}
