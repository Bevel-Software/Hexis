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
