import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';

/**
 * Group discovery + access requests — the browser half of the backend's
 * `modules/groups`. One client for both concerns because they are one endpoint
 * family (`/api/groups*`) and one mental model: a group you cannot read is
 * still a place you can see and ask to be let into.
 *
 * Every type below MIRRORS the backend contract (`groups.contract.ts`). Keep
 * them in step: `email: string | null` is not a convenience, it is the wire
 * telling you the caller isn't allowed to know.
 */

export interface GroupPrincipals {
  roles: string[];
  /** `email` is null on entries the caller cannot read — never render a blank one. */
  users: { name: string; email: string | null }[];
}

export interface GroupReaders extends GroupPrincipals {
  /** False when `read: everyone` applies cleanly (the lists are then empty). */
  restricted: boolean;
}

export interface GroupSummary {
  /** Group folder name, e.g. `GTM`. */
  name: string;
  /** Repo-relative constituent folders — two of them on an unmigrated KB. */
  folders: string[];
  /** Per-caller; locked === !canRead. */
  canRead: boolean;
  /** Per-caller; true ⇒ may manage the group's access (admin-rescue applies). */
  canWrite: boolean;
  /** The group's TOTALS, not the caller's slice — a locked group still has them. */
  skillCount: number;
  toolCount: number;
  owners: GroupPrincipals;
  writers: GroupPrincipals;
  /** null when the caller cannot read — a locked group never shows its share list. */
  readers: GroupReaders | null;
  /** The caller has a pending access request; always false when `canRead`. */
  hasRequested: boolean;
}

export interface GroupAccessRequestEntry {
  id: string;
  group: string;
  requesterName: string;
  requesterEmail: string;
  /** ISO timestamp. */
  createdAt: string;
}

/**
 * Thrown when a request is refused because access already landed — between the
 * page load and the click. Not an error to show: the right response is to
 * reload the library and let the group appear unlocked.
 */
export class AlreadyReadableError extends Error {
  constructor() {
    super('You can already read this group');
    this.name = 'AlreadyReadableError';
  }
}

export async function listGroups(): Promise<GroupSummary[]> {
  const res = await authFetch('/api/groups');
  if (!res.ok) throw new Error("Couldn't load groups.");
  const data = (await res.json()) as { groups: GroupSummary[] };
  return data.groups;
}

export async function requestGroupAccess(name: string): Promise<void> {
  const res = await authFetch(`/api/groups/${encodeURIComponent(name)}/access-requests`, {
    method: 'POST',
  });
  if (res.status === 409) {
    // Read from a CLONE: this is a probe for one specific conflict, and any
    // other 409 has to fall through to `handleApiResponse` with its body
    // intact. Reading `res` itself would leave the real error path throwing
    // "Body is unusable" instead of the server's message.
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { kind?: string };
    if (body.kind === 'already-readable') throw new AlreadyReadableError();
  }
  await handleApiResponse<{ ok: true }>(res);
}

/** Admin-gated by construction: a non-admin gets `[]`, never a 403. */
export async function listGroupAccessRequests(): Promise<GroupAccessRequestEntry[]> {
  const data = await handleApiResponse<{ requests: GroupAccessRequestEntry[] }>(
    await authFetch('/api/groups/access-requests'),
  );
  return data.requests;
}

export async function dismissGroupAccessRequest(id: string): Promise<void> {
  await handleApiResponse<{ ok: true }>(
    await authFetch(`/api/groups/access-requests/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
    }),
  );
}
