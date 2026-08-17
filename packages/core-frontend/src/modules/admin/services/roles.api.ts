import { authFetch } from '../../../lib/api';

/**
 * Typed client for the admin Roles & Members surface. Mirrors the backend shape
 * in `roles-admin.service.ts`. Re-declared here (rather than imported from
 * `@bevel-software/platform-shared`) to match the rest of the small admin feature, which
 * keeps its types frontend-local.
 */
export interface RoleRosterEntry {
  canonical: string;
  displayName: string;
  /** Individual members — emails only; group assignments live in `groups`. */
  members: string[];
  /** Canonical names of groups assigned to this role. */
  groups: string[];
  isAdmin: boolean;
  /**
   * What the role DOES. `null` marks a legacy people-set role (no capability
   * behind it) — those get the "Convert to group" action instead of group
   * assignment being meaningful.
   */
  capability: { description: string; groupAssignable: boolean } | null;
  referencedBy: { path: string; verb: string }[];
}

/**
 * Error carrying the backend's HTTP status and optional `kind` discriminator so
 * callers can branch on 409 `self-admin-removal` (confirm flow) vs lock
 * contention, surface 422 invariants verbatim, etc.
 */
export class RolesApiError extends Error {
  status: number;
  kind?: string;
  constructor(message: string, status: number, kind?: string) {
    super(message);
    this.name = 'RolesApiError';
    this.status = status;
    this.kind = kind;
  }
}

async function parseRoster(res: Response): Promise<RoleRosterEntry[]> {
  const body = (await res.json().catch(() => ({}))) as {
    roles?: RoleRosterEntry[];
    error?: string;
    kind?: string;
  };
  if (!res.ok) {
    throw new RolesApiError(
      body.error || `Request failed (${res.status})`,
      res.status,
      body.kind,
    );
  }
  return body.roles ?? [];
}

export async function fetchRoles(): Promise<RoleRosterEntry[]> {
  const res = await authFetch('/api/access/roles');
  return parseRoster(res);
}

/** Whether the default-branch roles.yaml currently parses. */
export interface RolesConfigHealth {
  ok: boolean;
  errors: string[];
}

/**
 * Auth-only health probe for roles.yaml. On a transient/network failure we
 * assume healthy rather than flash the scary "corrupted" banner on a blip — a
 * real corruption persists and the next poll catches it.
 */
export async function getRolesHealth(): Promise<RolesConfigHealth> {
  try {
    const res = await authFetch('/api/access/roles/health');
    if (!res.ok) return { ok: true, errors: [] };
    const body = (await res.json().catch(() => ({}))) as Partial<RolesConfigHealth>;
    return { ok: body.ok !== false, errors: body.errors ?? [] };
  } catch {
    return { ok: true, errors: [] };
  }
}

/** Trigger the Bevel Recovery: back up the corrupted file + restore the default. */
export async function recoverRoles(): Promise<RoleRosterEntry[]> {
  const res = await authFetch('/api/access/roles/recover', { method: 'POST' });
  return parseRoster(res);
}

export async function createRole(displayName: string): Promise<RoleRosterEntry[]> {
  const res = await authFetch('/api/access/roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  return parseRoster(res);
}

export async function deleteRole(canonical: string): Promise<RoleRosterEntry[]> {
  const res = await authFetch(`/api/access/roles/${encodeURIComponent(canonical)}`, {
    method: 'DELETE',
  });
  return parseRoster(res);
}

export async function renameRole(
  canonical: string,
  newDisplayName: string,
): Promise<RoleRosterEntry[]> {
  const res = await authFetch(`/api/access/roles/${encodeURIComponent(canonical)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newDisplayName }),
  });
  return parseRoster(res);
}

export async function addMember(
  canonical: string,
  email: string,
): Promise<RoleRosterEntry[]> {
  const res = await authFetch(
    `/api/access/roles/${encodeURIComponent(canonical)}/members`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    },
  );
  return parseRoster(res);
}

export async function removeMember(
  canonical: string,
  email: string,
  confirm?: boolean,
): Promise<RoleRosterEntry[]> {
  const qs = confirm ? '?confirm=true' : '';
  const res = await authFetch(
    `/api/access/roles/${encodeURIComponent(canonical)}/members/${encodeURIComponent(email)}${qs}`,
    { method: 'DELETE' },
  );
  return parseRoster(res);
}

/** Assign a GROUP to a role — everyone in the group gets the capability. */
export async function assignGroup(
  canonical: string,
  group: string,
): Promise<RoleRosterEntry[]> {
  const res = await authFetch(
    `/api/access/roles/${encodeURIComponent(canonical)}/groups`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group }),
    },
  );
  return parseRoster(res);
}

export async function unassignGroup(
  canonical: string,
  group: string,
): Promise<RoleRosterEntry[]> {
  const res = await authFetch(
    `/api/access/roles/${encodeURIComponent(canonical)}/groups/${encodeURIComponent(group)}`,
    { method: 'DELETE' },
  );
  return parseRoster(res);
}

/**
 * Convert a legacy people-set role into a manual group. Grants keep working —
 * the name is unchanged; it just moves to the groups file.
 */
export async function convertRoleToGroup(canonical: string): Promise<RoleRosterEntry[]> {
  const res = await authFetch(
    `/api/access/roles/${encodeURIComponent(canonical)}/convert-to-group`,
    { method: 'POST' },
  );
  return parseRoster(res);
}
