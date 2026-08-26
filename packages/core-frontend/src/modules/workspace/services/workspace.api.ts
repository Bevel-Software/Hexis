import type { WorkspaceInfo, FileTreeEntry } from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';

/**
 * Thrown by the workspace HTTP surface so callers can discriminate between
 * 404 (file missing on the current branch — recoverable, render a not-found
 * state), 401/403 (auth lapsed — bounce to login), and 5xx/network failures
 * (transient — surface a "couldn't load" banner the user can retry). The
 * previous `new Error('HTTP 404')` collapsed all of these into the same
 * untyped string and forced FileRoute to assume "any error means missing."
 */
export class WorkspaceApiError extends Error {
  readonly status: number;
  constructor(status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = 'WorkspaceApiError';
    this.status = status;
  }
}

/**
 * Get-or-create the workspace for a branch. Workspaces are per-branch
 * (PLAN §3) — every user editing the same branch shares the same
 * backend workspace. Pass no argument to land on the platform default
 * (target-company-state); pass a specific branch name to retarget.
 *
 * The returned `workspace.id` is `encodeURIComponent(branch)` and can be
 * derived client-side without a round-trip — that's what every other
 * `/workspace/:id/...` route expects. Callers who already know the
 * branch can compute the id themselves, but going through this endpoint
 * forces the backend to bootstrap (clone) the workspace if it's the
 * first access, so it's the safer choice on initial load and on branch
 * switches.
 */
export async function getOrCreateWorkspace(
  branch?: string,
): Promise<{ workspace: WorkspaceInfo; fileTree: FileTreeEntry }> {
  const qs = branch ? `?branch=${encodeURIComponent(branch)}` : '';
  const res = await authFetch(`/api/workspace${qs}`);
  if (!res.ok) throw new WorkspaceApiError(res.status);
  return res.json();
}

export async function listFiles(workspaceId: string): Promise<FileTreeEntry> {
  const res = await authFetch(`/api/workspace/${workspaceId}/files`);
  if (!res.ok) throw new WorkspaceApiError(res.status);
  return res.json();
}

/**
 * The pages the team touched most recently that this reader may open, newest
 * first — what the empty state offers someone with nothing open.
 *
 * Never throws: somewhere to start is an invitation, not the page itself, and
 * a caller that has to handle a failure here would only turn the invitation
 * into an error message. An empty array is also a real answer (a branch with
 * no history yet), and the caller treats both the same way: fall back to
 * walking the tree.
 */
export async function listRecentPages(
  workspaceId: string,
  limit = 4,
): Promise<FileTreeEntry[]> {
  try {
    const res = await authFetch(`/api/workspace/${workspaceId}/recent-pages?limit=${limit}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { pages?: FileTreeEntry[] };
    return Array.isArray(data.pages) ? data.pages : [];
  } catch {
    return [];
  }
}

export async function readFile(workspaceId: string, relativePath: string): Promise<string> {
  // `_` cache-bust query parameter. The backend already sends
  // `Cache-Control: no-store` on this route, but intermediate CDNs /
  // service workers can ignore that header. A unique URL per request
  // guarantees we hit the origin every time — important for the live
  // refresh path where a teammate's save fires file-changed and we
  // refetch milliseconds later (a stale response defeats the whole
  // point of the SSE update).
  const bust = `_=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await authFetch(`/api/workspace/${workspaceId}/file?path=${encodeURIComponent(relativePath)}&${bust}`);
  if (!res.ok) throw new WorkspaceApiError(res.status);
  const data = await res.json();
  return data.content;
}

export async function writeFile(
  workspaceId: string,
  relativePath: string,
  content: string,
  options?: { ifAbsent?: boolean },
): Promise<void> {
  const res = await authFetch(`/api/workspace/${workspaceId}/file?path=${encodeURIComponent(relativePath)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    // `ifAbsent` asks the backend for an exclusive create — a 409 instead of
    // a silent replace when the target already exists.
    body: JSON.stringify(options?.ifAbsent ? { content, ifAbsent: true } : { content }),
  });
  if (!res.ok) throw await toApiError(res);
}

/**
 * Turn a non-OK response into a `WorkspaceApiError` that carries the
 * backend's `{ error }` body as its message. Without this the file-mutation
 * routes threw a bare `Error('HTTP 403')`, so the file-explorer's
 * "Couldn't add X" banner showed an opaque status code instead of the real
 * reason (e.g. "You don't have permission to write to …"). Shared by every
 * mutating route so the whole workspace API surfaces the backend message
 * uniformly.
 */
async function toApiError(res: Response): Promise<WorkspaceApiError> {
  let msg = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body?.error) msg = body.error;
  } catch {
    // body wasn't JSON — fall through with the HTTP status message
  }
  return new WorkspaceApiError(res.status, msg);
}

export async function createDirectory(
  workspaceId: string,
  relativePath: string,
  options?: { defer?: boolean },
): Promise<void> {
  const res = await authFetch(`/api/workspace/${workspaceId}/directory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: relativePath, defer: options?.defer }),
  });
  if (!res.ok) throw await toApiError(res);
}

export async function uploadFile(
  workspaceId: string,
  relativePath: string,
  file: File,
  options?: { defer?: boolean },
): Promise<void> {
  // `defer=true` opts into the batch path: the server commits but skips
  // the per-file push + fs-tree event. The caller is responsible for
  // following up with `flushBatch` once at the end of the burst.
  const qs = `path=${encodeURIComponent(relativePath)}${options?.defer ? '&defer=true' : ''}`;
  const res = await authFetch(`/api/workspace/${workspaceId}/upload?${qs}`, {
    method: 'POST',
    body: file,
  });
  if (!res.ok) throw await toApiError(res);
}

/**
 * End-of-batch checkpoint for folder-upload bursts. Pushes all locally
 * accumulated commits to origin in one round-trip and triggers a single
 * `fs-tree-changed` event server-side. Pair with N `uploadFile(...,
 * { defer: true })` (and any `createDirectory(..., { defer: true })`)
 * calls. The HTTP response carries the same `PushNeedsAgentResolutionError`
 * payload as a failed single-file save when the push hits a
 * non-fast-forward / conflict path, so callers can surface the
 * agent-handoff prompt the same way.
 */
export async function flushBatch(
  workspaceId: string,
  targetPath?: string,
): Promise<void> {
  const res = await authFetch(`/api/workspace/${workspaceId}/flush`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetPath: targetPath ?? '.' }),
  });
  if (!res.ok) throw await toApiError(res);
}

export async function moveEntry(workspaceId: string, oldPath: string, newPath: string): Promise<void> {
  const res = await authFetch(`/api/workspace/${workspaceId}/file`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPath, newPath }),
  });
  if (!res.ok) throw await toApiError(res);
}

export async function deleteFile(workspaceId: string, relativePath: string): Promise<void> {
  const res = await authFetch(`/api/workspace/${workspaceId}/file?path=${encodeURIComponent(relativePath)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw await toApiError(res);
}

export interface UnzipResult {
  destination: string;
  extracted: string[];
  skipped: { path: string; reason: string }[];
}

export async function unzipFile(
  workspaceId: string,
  zipPath: string,
  destination?: string,
): Promise<UnzipResult> {
  const res = await authFetch(`/api/workspace/${workspaceId}/unzip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: zipPath, destination }),
  });
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  const res = await authFetch(`/api/workspace/${workspaceId}`, { method: 'DELETE' });
  if (!res.ok) throw await toApiError(res);
}
