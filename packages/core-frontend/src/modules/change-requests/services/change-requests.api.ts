import type {
  FolderChangeRequest,
  FolderChangeRequestRemoval,
  PullRequestSummary,
} from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';
import {
  WorkspaceApiError,
  getOrCreateWorkspace,
  rawFileUrl,
  readFile,
} from '../../workspace/services/workspace.api';
import { BranchUnavailableError } from '../utils/readFailure';

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

/**
 * Read a file from a branch's shared workspace (bootstraps the clone if
 * needed). A failure to open the branch is answered as
 * {@link BranchUnavailableError}, never as the file read's own error: both
 * answer 404 for different reasons, and a caller that reads a file-read 404
 * as "the branch has no such file" must not be told that about a branch that
 * could not be opened.
 */
export async function readFileOnBranch(branch: string, repoRelativePath: string): Promise<string> {
  let workspace: Awaited<ReturnType<typeof getOrCreateWorkspace>>['workspace'];
  try {
    ({ workspace } = await getOrCreateWorkspace(branch));
  } catch (err: unknown) {
    throw new BranchUnavailableError(branch, err);
  }
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

/**
 * A file's text at a commit of a branch's workspace — `side: 'after'` the
 * commit itself, `'before'` its first parent — through the raw route Version
 * history reads past saves with, behind the same read gate as any file read.
 * What an APPLIED request's file is read with: its merge commit against the
 * target as it stood just before the apply. A refusal or a missing path
 * rejects with a `WorkspaceApiError` carrying the status.
 */
export async function readFileAtCommit(
  workspaceId: string,
  workspacePath: string,
  sha: string,
  side: 'after' | 'before',
): Promise<string> {
  const res = await authFetch(rawFileUrl(workspaceId, workspacePath, { ref: sha, side }));
  if (!res.ok) throw new WorkspaceApiError(res.status, await errorMessage(res));
  return res.text();
}

/**
 * Whether a file exists on a branch's workspace NOW — the "Open page" or
 * "This page has since been deleted." question of a finished request's file.
 * A HEAD on the raw route: no bytes, binary files included. `true` for a
 * 2xx, `false` only for a 404. Every other answer rejects as a failed read
 * would: a refusal (403) as a `WorkspaceApiError` so the file shows locked,
 * any other status as a `WorkspaceApiError` carrying it and a network drop
 * as the error `fetch` threw, so the file says it couldn't be read, with Try
 * again — never "Open page" to a page nobody could confirm, and never
 * "deleted" for a page that may well be there.
 */
export async function fileExistsOnWorkspace(
  workspaceId: string,
  workspacePath: string,
): Promise<boolean> {
  // A HEAD answer has no body, so the status is all there is to say.
  const res = await authFetch(rawFileUrl(workspaceId, workspacePath), { method: 'HEAD' });
  if (res.status === 404) return false;
  if (!res.ok) throw new WorkspaceApiError(res.status);
  return true;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === 'string') return body.error;
  } catch {
    // Not JSON: the status says it.
  }
  return `HTTP ${res.status}`;
}
