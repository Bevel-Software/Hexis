import type {
  FolderChangeRequest,
  FolderChangeRequestRemoval,
  PullRequestSummary,
} from '@bevel-software/platform-shared';
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

/**
 * The open change requests proposing files under a KB-repo-relative folder,
 * each with whether the caller may take those files out of it — what a folder
 * delete asks before it offers to remove the proposals too.
 */
export async function listChangeRequestsUnderFolder(folder: string): Promise<FolderChangeRequest[]> {
  const data = await handleApiResponse<{ requests: FolderChangeRequest[] }>(
    await authFetch(`/api/workflow/change-requests/under-folder?path=${encodeURIComponent(folder)}`),
  );
  return data.requests;
}

/**
 * Take every file under the folder out of every open change request proposing
 * one. A request left empty is withdrawn. Refused as a whole (403) when the
 * caller may not act on one of them.
 */
export async function removeFolderFromChangeRequests(folder: string): Promise<FolderChangeRequestRemoval[]> {
  const data = await handleApiResponse<{ results: FolderChangeRequestRemoval[] }>(
    await authFetch('/api/workflow/change-requests/under-folder/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    }),
  );
  return data.results;
}

/** Read a file from a branch's shared workspace (bootstraps the clone if needed). */
export async function readFileOnBranch(branch: string, repoRelativePath: string): Promise<string> {
  const { workspace } = await getOrCreateWorkspace(branch);
  return readFile(workspace.id, `${workspace.kbDirName}/${repoRelativePath}`);
}

/** A file read at a change request's fork point. */
export interface ForkPointFile {
  /** The file's text there; `null` when the path did not exist at the fork point. */
  content: string | null;
  /** The fork point read; `null` when the branches share no history (nothing was read). */
  forkSha: string | null;
}

/**
 * A file as it stood at a change request's fork point — the "before" side of
 * every diff of the request. Pass `sha` (the detail's `mergeBaseSha`) when you
 * hold one; `null` asks the server for the request's current fork point.
 */
export async function readFileAtForkPoint(
  crNumber: number,
  sha: string | null,
  repoRelativePath: string,
): Promise<ForkPointFile> {
  const qs = new URLSearchParams({ path: repoRelativePath, ...(sha ? { sha } : {}) });
  return handleApiResponse<ForkPointFile>(
    await authFetch(`/api/workflow/change-requests/${crNumber}/fork-point-file?${qs}`),
  );
}
