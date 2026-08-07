import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';

/**
 * Group enumeration + join requests — the browser half of the backend's
 * `modules/groups`.
 *
 * Enumeration is fail-closed with three ordinary access verdicts: a listed
 * group is one the caller is a MEMBER of (`canRead`), MANAGES (`canWrite`,
 * admin-rescued), or may DISCOVER (they can read the group's `access.md`
 * file — granted by its own `read: everyone` frontmatter). A group with no
 * verdict is absent. Asking to join opens a plain change request; nothing
 * request-shaped is stored anywhere else.
 *
 * Every type below MIRRORS the backend contract (`groups.contract.ts`). Keep
 * them in step.
 */

export interface GroupPrincipals {
  roles: string[];
  users: { name: string; email: string }[];
}

export interface GroupReaders extends GroupPrincipals {
  /** False when `read: everyone` applies cleanly (the lists are then empty). */
  restricted: boolean;
}

export interface GroupSummary {
  /** Group folder name, e.g. `GTM`. */
  name: string;
  /** Repo-relative constituent folders, e.g. `['Groups/GTM']`. */
  folders: string[];
  /** Per-caller: can read the folder (membership). Locked === !canRead. */
  canRead: boolean;
  /** Per-caller; true ⇒ may manage the group's access (admin-rescue applies). */
  canWrite: boolean;
  /** The group's TOTALS, not the caller's slice. */
  skillCount: number;
  toolCount: number;
  owners: GroupPrincipals;
  writers: GroupPrincipals;
  readers: GroupReaders;
  /** The caller has an OPEN join change request for this group. */
  hasRequested: boolean;
  /** That CR's number when `hasRequested` (deep-links the review UI). */
  requestNumber: number | null;
}

export async function listGroups(): Promise<GroupSummary[]> {
  const res = await authFetch('/api/groups');
  if (!res.ok) throw new Error("Couldn't load groups.");
  const data = (await res.json()) as { groups: GroupSummary[] };
  return data.groups;
}

/**
 * Create a group — the dedicated provisioning endpoint, not a workspace
 * write. The server owns name validation and the collision verdict (its
 * check is against the live tree, ours against a stale catalog), commits the
 * seeded `access.md` before answering, and refuses with its own words —
 * worth surfacing verbatim.
 */
export async function createGroup(name: string): Promise<{ folder: string }> {
  const res = await authFetch('/api/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't create that group.");
  }
  return (await res.json()) as { folder: string };
}

/**
 * Ensure the caller's personal folder (`Groups/personal-<id>/`) exists.
 * Idempotent; the server answers only after the folder's access.md is
 * COMMITTED, so a write into the folder may follow immediately.
 */
export async function ensurePersonalGroup(): Promise<{ folder: string; created: boolean }> {
  const res = await authFetch('/api/groups/personal', { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't prepare your personal folder.");
  }
  return (await res.json()) as { folder: string; created: boolean };
}

/**
 * Thrown when a join request is refused because access already landed —
 * between the page load and the click. Not an error to show: the right
 * response is to reload the library and let the group appear unlocked.
 */
export class AlreadyReadableError extends Error {
  constructor() {
    super('You can already read this group');
    this.name = 'AlreadyReadableError';
  }
}

/** Open (or return the existing) join change request. Idempotent server-side. */
export async function requestGroupAccess(name: string): Promise<{ number: number }> {
  const res = await authFetch(`/api/groups/${encodeURIComponent(name)}/join-request`, {
    method: 'POST',
  });
  if (res.status === 409) {
    // Read from a CLONE: this probes one specific conflict; any other 409
    // falls through to `handleApiResponse` with its body intact.
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { kind?: string };
    if (body.kind === 'already-readable') throw new AlreadyReadableError();
  }
  return handleApiResponse<{ ok: true; number: number }>(res);
}

/**
 * ONE grant a join request is proposing — a principal and the verb it would
 * get. Mirrors the backend's `JoinProposal`; `principal` is the shape the
 * access-grant API takes, so accepting is a plain grant.
 */
export interface JoinProposal {
  verb: 'read' | 'write' | 'owner' | 'download';
  /** Canonical identity (lowercased email / canonical role) — a stable key. */
  id: string;
  principal:
    | { kind: 'user'; email: string; displayName: string }
    | { kind: 'role'; role: string };
  label: string;
}

export interface JoinRequest {
  number: number;
  branch: string;
  requesterName: string;
  createdAt: string;
  /** Still-pending proposals; a request with none left is already closed. */
  proposals: JoinProposal[];
}

/**
 * Open join requests for a group the caller MANAGES, each with what it still
 * proposes. Non-managers get `[]` (never a 403), so the caller may ask
 * unconditionally — the same posture every other group surface takes.
 */
export async function listJoinRequests(name: string): Promise<JoinRequest[]> {
  const data = await handleApiResponse<{ requests: JoinRequest[] }>(
    await authFetch(`/api/groups/${encodeURIComponent(name)}/join-requests`),
  );
  return data.requests;
}

/**
 * Ask the server to settle a request whose proposals have all landed. Called
 * after a grant so the banner updates now rather than on the next listing —
 * which reconciles anyway, so a failure here only delays it.
 */
export async function reconcileJoinRequest(name: string, number: number): Promise<boolean> {
  const data = await handleApiResponse<{ closed: boolean }>(
    await authFetch(
      `/api/groups/${encodeURIComponent(name)}/join-requests/${number}/reconcile`,
      { method: 'POST' },
    ),
  );
  return data.closed;
}
