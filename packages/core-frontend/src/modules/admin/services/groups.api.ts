import { authFetch } from '../../../lib/api';

/**
 * Typed client for the admin Groups surface (`/api/admin/groups*`, admins
 * only) — the "who you are" half of the roles/groups split. Mirrors the
 * backend shape in `groups-admin.service.ts`; re-declared frontend-local like
 * the rest of the admin feature's clients.
 */

/**
 * Where groups come from in this deployment. One source at a time:
 * `manual` — created and edited in-app; `idp` — synced from the identity
 * provider over SCIM, read-only here (every mutation answers 409).
 */
export type GroupsMode = 'manual' | 'idp';

export interface GroupRosterEntry {
  canonical: string;
  displayName: string;
  members: string[];
  /** Every access rule referencing this group — drives the delete warning. */
  referencedBy: { path: string; verb: string }[];
}

export interface GroupsRoster {
  mode: GroupsMode;
  groups: GroupRosterEntry[];
}

/**
 * Error carrying the backend's HTTP status and optional `kind` discriminator
 * so callers can branch on the 409 `idp-mode` refusal (mutations attempted
 * while the IdP owns the groups) without string-matching messages.
 */
export class GroupsApiError extends Error {
  status: number;
  kind?: string;
  constructor(message: string, status: number, kind?: string) {
    super(message);
    this.name = 'GroupsApiError';
    this.status = status;
    this.kind = kind;
  }
}

async function parseRoster(res: Response): Promise<GroupsRoster> {
  const body = (await res.json().catch(() => ({}))) as Partial<GroupsRoster> & {
    error?: string;
    kind?: string;
  };
  if (!res.ok) {
    throw new GroupsApiError(
      body.error || `Request failed (${res.status})`,
      res.status,
      body.kind,
    );
  }
  return { mode: body.mode ?? 'manual', groups: body.groups ?? [] };
}

export async function getGroupsRoster(): Promise<GroupsRoster> {
  const res = await authFetch('/api/admin/groups');
  return parseRoster(res);
}

export async function createGroup(displayName: string): Promise<GroupsRoster> {
  const res = await authFetch('/api/admin/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  return parseRoster(res);
}

export async function deleteGroup(canonical: string): Promise<GroupsRoster> {
  const res = await authFetch(`/api/admin/groups/${encodeURIComponent(canonical)}`, {
    method: 'DELETE',
  });
  return parseRoster(res);
}

export async function addGroupMember(
  canonical: string,
  email: string,
): Promise<GroupsRoster> {
  const res = await authFetch(
    `/api/admin/groups/${encodeURIComponent(canonical)}/members`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    },
  );
  return parseRoster(res);
}

export async function removeGroupMember(
  canonical: string,
  email: string,
): Promise<GroupsRoster> {
  const res = await authFetch(
    `/api/admin/groups/${encodeURIComponent(canonical)}/members/${encodeURIComponent(email)}`,
    { method: 'DELETE' },
  );
  return parseRoster(res);
}
