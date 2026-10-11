import type {
  AcquireLockResult,
  Change,
  FileLock,
} from '@bevel-software/platform-shared';
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

/**
 * What a person reads when the server says they no longer hold the file —
 * it went idle, or expired, before a save or a heartbeat landed. The
 * server's own sentence ("Cannot release lock on …: not held by you")
 * names the mechanism; the person only needs to know their editing
 * stopped and what to do about it. Said without naming a save: every call
 * here answers with it, the heartbeat included, and a heartbeat that finds
 * the session gone attempted no save at all.
 */
export const EDITING_ENDED_MESSAGE =
  'Your editing session ended. Check the page and edit it again if anything is missing.';

/**
 * What a person reads when the page is held under their own user id —
 * another of their tabs, a browser that closed without giving it back, or
 * their agent saving. Never "<their own name> is editing this page": the
 * server refuses their own live hold on purpose (an agent writes as the
 * person who connected it), so the honest answer is that it is theirs and
 * will free up.
 */
export const SELF_HOLD_MESSAGE =
  'You have this page open for editing somewhere else, in another tab or through your agent. You can edit it here in a moment.';

async function unwrap<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let body: unknown;
  let message = `HTTP ${res.status}`;
  try {
    body = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      message = String((body as { error: unknown }).error);
    }
    if (body && typeof body === 'object' && (body as { kind?: unknown }).kind === 'lock-not-held') {
      message = EDITING_ENDED_MESSAGE;
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
 * holder's lock state is included so the UI can render "X is editing
 * this page" without a follow-up call).
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
 *
 * `keepalive` lets the request outlive the page that sends it: the release
 * a closing or reloading tab sends on `pagehide`. Unlike `sendBeacon`, a
 * keep-alive `fetch` still carries the bearer header.
 */
export async function releaseLock(
  workspaceId: string,
  branch: string,
  path: string,
  summary?: string,
  options: { keepalive?: boolean } = {},
): Promise<Change | null> {
  const { change } = await unwrap<{ change: Change | null }>(
    await authFetch(`/api/workspace/${workspaceId}/workflow/locks`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, path, summary }),
      ...(options.keepalive ? { keepalive: true } : {}),
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
