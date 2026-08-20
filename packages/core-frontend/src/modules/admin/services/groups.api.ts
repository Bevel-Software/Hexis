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
  /**
   * Canonical names of roles carrying an assignment to this group — deleting
   * the group also unassigns it from these roles (they lose the members they
   * inherit through it), which the delete confirm must say. Optional
   * defensively: a skewed server may omit it, and rendering must not throw.
   */
  assignedToRoles?: string[];
}

/**
 * Health of the ACTIVE groups source. `ok: false` means the source file
 * exists but cannot be read/parsed — groups then contribute NOTHING to
 * access resolution until repaired, which the page banners loudly.
 */
export type GroupsHealth = { ok: true } | { ok: false; file: string; reason: string };

export interface GroupsRoster {
  mode: GroupsMode;
  groups: GroupRosterEntry[];
  /** See {@link GroupsHealth}. Defaulted to ok when a skewed server omits it. */
  groupsHealth: GroupsHealth;
}

/**
 * Error carrying the backend's HTTP status and optional `kind` discriminator
 * so callers can branch on the 409 `idp-mode` refusal (mutations attempted
 * while the IdP owns the groups) without string-matching messages.
 */
export class GroupsApiError extends Error {
  status: number;
  kind?: string;
  /** The broken source file (422 `broken-groups` payloads carry it). */
  file?: string;
  /** The parse/read failure message (422 `broken-groups` payloads carry it). */
  reason?: string;
  constructor(message: string, status: number, kind?: string, extra?: { file?: string; reason?: string }) {
    super(message);
    this.name = 'GroupsApiError';
    this.status = status;
    this.kind = kind;
    this.file = extra?.file;
    this.reason = extra?.reason;
  }
}

async function parseRoster(res: Response): Promise<GroupsRoster> {
  const body = (await res.json().catch(() => ({}))) as Partial<GroupsRoster> & {
    error?: string;
    kind?: string;
    file?: string;
    reason?: string;
  };
  if (!res.ok) {
    throw new GroupsApiError(
      body.error || `Request failed (${res.status})`,
      res.status,
      body.kind,
      { file: body.file, reason: body.reason },
    );
  }
  return {
    mode: body.mode ?? 'manual',
    groups: body.groups ?? [],
    groupsHealth: body.groupsHealth ?? { ok: true },
  };
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

/**
 * Rename a group. Canonical-changing renames rewrite every grant reference
 * (and roles.yaml `group:` assignments) atomically server-side.
 */
export async function renameGroup(
  canonical: string,
  newDisplayName: string,
): Promise<GroupsRoster> {
  const res = await authFetch(`/api/admin/groups/${encodeURIComponent(canonical)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newDisplayName }),
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
