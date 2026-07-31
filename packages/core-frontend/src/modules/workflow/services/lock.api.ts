import type {
  AcquireLockResult,
  Change,
  FileLock,
} from '@bevel-software/shared';
import { authFetch } from '../../../lib/api';

/**
 * Client for `/workspace/:id/workflow/locks/*` — the file-lock primitives
 * the editor uses to coordinate concurrent edits across users on the same
 * branch's shared workspace (PLAN §2). All four backend endpoints map 1:1.
 *
 * On non-2xx responses these functions throw a `LockApiError` carrying the
 * HTTP status + parsed payload so the editor can distinguish "someone else
 * holds the lock" (`acquired: false` in the body) from "lock expired"
 * (409 from heartbeat) from real infra failures.
 */
export class LockApiError extends Error {
  readonly status: number;
  readonly body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'LockApiError';
    this.status = status;
    this.body = body;
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let body: unknown;
  let message = `HTTP ${res.status}`;
  try {
    body = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      message = String((body as { error: unknown }).error);
    }
  } catch {
    // non-JSON body — fall through with default message
  }
  throw new LockApiError(res.status, message, body);
}

/**
 * Try to acquire the lock for `(branch, path)`. Resolves with the
 * `AcquireLockResult` payload — `acquired: true` when the caller now
 * holds the lock, `acquired: false` when someone else does (the
 * holder's lock state is included so the UI can render "Locked by X"
 * without a follow-up call).
 */
export async function acquireLock(
  workspaceId: string,
  branch: string,
  path: string,
): Promise<AcquireLockResult> {
  return unwrap(
    await authFetch(`/api/workspace/${workspaceId}/workflow/locks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, path }),
    }),
  );
}

/** Extend the lock's TTL. Throws if the caller no longer holds the lock. */
export async function heartbeatLock(
  workspaceId: string,
  branch: string,
  path: string,
): Promise<FileLock> {
  return unwrap(
    await authFetch(`/api/workspace/${workspaceId}/workflow/locks/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, path }),
    }),
  );
}

/**
 * Autosave checkpoint — commits the file's accumulated edits without
 * releasing the lock. Returns the new change or null when the file
 * had no pending edits. The frontend's editor calls this on its
 * periodic save tick so the lock stays held across many interim
 * commits.
 */
export async function checkpointLockedFile(
  workspaceId: string,
  branch: string,
  path: string,
  summary?: string,
): Promise<Change | null> {
  const { change } = await unwrap<{ change: Change | null }>(
    await authFetch(`/api/workspace/${workspaceId}/workflow/locks/checkpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, path, summary }),
    }),
  );
  return change;
}

/**
 * Release the lock AND commit any pending edits as a final change.
 * Returns `null` when the file had no pending edits (idempotent on a
 * clean release).
 */
export async function releaseLock(
  workspaceId: string,
  branch: string,
  path: string,
  summary?: string,
): Promise<Change | null> {
  const { change } = await unwrap<{ change: Change | null }>(
    await authFetch(`/api/workspace/${workspaceId}/workflow/locks`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, path, summary }),
    }),
  );
  return change;
}

/**
 * Read the current lock holder for `(branch, path)`. Returns null when
 * nobody holds it. The editor polls this when it doesn't hold the lock
 * to detect when another user starts / stops editing.
 */
export async function getLock(
  workspaceId: string,
  branch: string,
  path: string,
): Promise<FileLock | null> {
  const qs = new URLSearchParams({ branch, path }).toString();
  const { lock } = await unwrap<{ lock: FileLock | null }>(
    await authFetch(`/api/workspace/${workspaceId}/workflow/locks?${qs}`),
  );
  return lock;
}
