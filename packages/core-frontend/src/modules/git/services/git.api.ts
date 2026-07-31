import type {
  BranchInfo,
  CommitAttribution,
  WorkingTreeStatus,
} from '@bevel-software/shared';
import { authFetch } from '../../../lib/api';

/**
 * Branch + change + working-tree API client. Talks exclusively to
 * `/api/workspace/:id/workflow/*` — the legacy `/git/*` family was retired
 * with the workflow-module migration (see `bevel-platform/PLAN.md`).
 *
 * Naming inside the frontend still uses git vocabulary (`fetchStatus`,
 * `commit`, `push`) because the engineering glossary says internal symbols
 * keep their precise terms; only rendered UI strings switch to "save",
 * "share", etc. via `docs/glossary.md`.
 */
export class GitApiError extends Error {
  readonly status: number;
  readonly body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'GitApiError';
    this.status = status;
    this.body = body;
  }
}

export async function handleApiResponse<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let body: unknown;
  let message = `HTTP ${res.status}`;
  try {
    body = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      message = String((body as { error: unknown }).error);
    }
  } catch {
    // non-JSON body — keep default message
  }
  throw new GitApiError(res.status, message, body);
}

export async function fetchStatus(workspaceId: string): Promise<WorkingTreeStatus> {
  return handleApiResponse(await authFetch(`/api/workspace/${workspaceId}/workflow/branch-status`));
}

export async function fetchBranches(
  workspaceId: string,
  opts: { fresh?: boolean } = {},
): Promise<BranchInfo[]> {
  // `fresh` forces a server-side `git fetch --prune` (bypassing the implicit
  // TTL) so a user-initiated refresh reflects remote create/delete right away.
  const qs = opts.fresh ? '?fresh=1' : '';
  return handleApiResponse(await authFetch(`/api/workspace/${workspaceId}/workflow/branches${qs}`));
}

export async function createBranch(
  workspaceId: string,
  name: string,
  fromBase?: string,
): Promise<BranchInfo> {
  return handleApiResponse(
    await authFetch(`/api/workspace/${workspaceId}/workflow/branches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fromBase }),
    }),
  );
}

/**
 * Delete a local branch. With `onlyIfNoRemote: true` the backend refuses if
 * `origin/<name>` still exists — use that variant when auto-pruning after a
 * change request lands so you can't accidentally drop a branch still in use.
 */
export async function deleteBranch(
  workspaceId: string,
  name: string,
  opts: { onlyIfNoRemote?: boolean } = {},
): Promise<void> {
  const query = opts.onlyIfNoRemote ? '?onlyIfNoRemote=1' : '';
  await handleApiResponse(
    await authFetch(
      `/api/workspace/${workspaceId}/workflow/branches/${encodeURIComponent(name)}${query}`,
      { method: 'DELETE' },
    ),
  );
}

// `forkToDraft` removed: under save=share + per-branch workspaces, the
// dirty-edit carry-along escape hatch can't fire. `createBranch` + URL
// navigation to the new branch covers the "start a draft" intent.

export async function pull(workspaceId: string): Promise<void> {
  await handleApiResponse(
    await authFetch(`/api/workspace/${workspaceId}/workflow/update-from-remote`, { method: 'POST' }),
  );
}

export async function fetchForkBase(
  workspaceId: string,
  branch: string,
): Promise<string | null> {
  const data = await handleApiResponse<{ base: string | null }>(
    await authFetch(
      `/api/workspace/${workspaceId}/workflow/fork-base?branch=${encodeURIComponent(branch)}`,
    ),
  );
  return data.base;
}

export async function revert(
  workspaceId: string,
  sha: string,
): Promise<CommitAttribution> {
  return handleApiResponse(
    await authFetch(`/api/workspace/${workspaceId}/workflow/changes/${encodeURIComponent(sha)}/revert`, {
      method: 'POST',
    }),
  );
}

export async function fetchFileHistory(
  workspaceId: string,
  path: string,
  limit = 20,
): Promise<CommitAttribution[]> {
  const q = new URLSearchParams({ path, limit: String(limit) });
  const data = await handleApiResponse<{ changes: CommitAttribution[] }>(
    await authFetch(`/api/workspace/${workspaceId}/workflow/changes?${q.toString()}`),
  );
  return data.changes;
}

export async function fetchFileDiff(
  workspaceId: string,
  path: string,
  sha: string,
): Promise<string> {
  const q = new URLSearchParams({ path, sha });
  const data = await handleApiResponse<{ diff: string }>(
    await authFetch(`/api/workspace/${workspaceId}/workflow/show-file?${q.toString()}`),
  );
  return data.diff;
}

export async function fetchFileComparison(
  workspaceId: string,
  path: string,
  fromBranch: string,
  toBranch: string,
): Promise<string> {
  const q = new URLSearchParams({ path, from: fromBranch, to: toBranch });
  const data = await handleApiResponse<{ diff: string }>(
    await authFetch(`/api/workspace/${workspaceId}/workflow/compare-file?${q.toString()}`),
  );
  return data.diff;
}

// `fetchWorkingStatus` + `fetchWorkingDiff` removed: under save=share the
// working tree is never dirty, so both surfaces are always empty. Cross-
// branch comparison + commit history cover the meaningful diff cases.
