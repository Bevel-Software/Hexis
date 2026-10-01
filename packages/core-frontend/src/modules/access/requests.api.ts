import { authFetch } from '../../lib/api';
import { handleApiResponse } from '../git/services/git.api';

/** The two levels the Manage access dialog can ask for. Owner covers Can edit. */
export type RequestLevel = 'write' | 'owner';

/** The dialog's own words for a level — the same ones its row menu uses. */
export const LEVEL_WORDS: Record<RequestLevel, string> = {
  write: 'Can edit',
  owner: 'Owner',
};

/** The longest note a request can carry, in characters. Mirrors the server's cap. */
export const REQUEST_NOTE_MAX = 500;

/**
 * What the requester's own dialog shows in place of the control.
 *
 * `not-accepted` means their last request closed without the access landing —
 * declined by an editor, or withdrawn by themselves. The two read the same on
 * purpose: nothing records WHO closed a request, and inventing a difference
 * would need a new column.
 */
export interface AccessRequestStatus {
  state: 'none' | 'pending' | 'not-accepted';
  level?: RequestLevel;
  number?: number;
}

/** One grant a request still proposes — the shape `grantAccess` takes. */
export interface AccessProposal {
  verb: 'read' | 'write' | 'owner' | 'download';
  /** Canonical identity (lowercased email / canonical role) — a stable key. */
  id: string;
  principal:
    | { kind: 'user'; email: string; displayName: string }
    | { kind: 'role'; role: string };
  label: string;
}

/** One open request, as the editors' surfaces render it. */
export interface AccessRequestRow {
  number: number;
  branch: string;
  requesterName: string;
  createdAt: string;
  /** Still-pending proposals; a request with none left is already closed. */
  proposals: AccessProposal[];
  /** The requester's note, as plain text, when they wrote one. */
  note?: string;
}

/** Repo- or workspace-relative path plus what it is; both are sent verbatim. */
interface TargetQuery {
  path: string;
  kind: 'folder' | 'file';
}

const query = (t: TargetQuery) => `path=${encodeURIComponent(t.path)}&kind=${t.kind}`;

/** Where the caller's own request on this item stands. */
export async function fetchAccessRequestStatus(
  workspaceId: string,
  target: TargetQuery,
): Promise<AccessRequestStatus> {
  return handleApiResponse(
    await authFetch(`/api/workspace/${workspaceId}/access/request?${query(target)}`),
  );
}

/**
 * Ask for `level` on this item. Idempotent by (person, item): a second send
 * while a request is open answers with that same request rather than opening
 * a rival, so a double click leaves exactly one.
 */
export async function sendAccessRequest(
  workspaceId: string,
  input: TargetQuery & { level: RequestLevel; note?: string },
): Promise<{ number: number; level: RequestLevel }> {
  return handleApiResponse(
    await authFetch(`/api/workspace/${workspaceId}/access/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

/**
 * The open requests for an item the caller EDITS. Everyone else gets `[]`
 * rather than a 403, so the dialog may ask unconditionally — "am I an editor
 * here" stays a question only the server answers.
 */
export async function listAccessRequests(
  workspaceId: string,
  target: TargetQuery,
): Promise<AccessRequestRow[]> {
  const data = await handleApiResponse<{ requests: AccessRequestRow[] }>(
    await authFetch(`/api/workspace/${workspaceId}/access/requests?${query(target)}`),
  );
  return data.requests;
}

/**
 * Ask the server to settle a request whose proposals have all landed. The
 * listing does this lazily too, so a failure here only delays it.
 */
export async function reconcileAccessRequest(
  workspaceId: string,
  number: number,
  target: TargetQuery,
): Promise<boolean> {
  const data = await handleApiResponse<{ closed: boolean }>(
    await authFetch(`/api/workspace/${workspaceId}/access/requests/${number}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target),
    }),
  );
  return data.closed;
}
