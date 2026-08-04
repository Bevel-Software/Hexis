import { authFetch } from '../../../lib/api';

/**
 * Group enumeration — the browser half of the backend's `modules/groups`.
 *
 * Fail-closed like every read surface: the endpoint only returns groups the
 * caller can access (read, or manage via admin-rescue), so everything below
 * is fully disclosed — there is no locked tier and no withheld field.
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
  /** Per-caller. Every listed group has `canRead` or `canWrite`. */
  canRead: boolean;
  /** Per-caller; true ⇒ may manage the group's access (admin-rescue applies). */
  canWrite: boolean;
  /** The group's TOTALS, not the caller's slice. */
  skillCount: number;
  toolCount: number;
  owners: GroupPrincipals;
  writers: GroupPrincipals;
  readers: GroupReaders;
}

export async function listGroups(): Promise<GroupSummary[]> {
  const res = await authFetch('/api/groups');
  if (!res.ok) throw new Error("Couldn't load groups.");
  const data = (await res.json()) as { groups: GroupSummary[] };
  return data.groups;
}
