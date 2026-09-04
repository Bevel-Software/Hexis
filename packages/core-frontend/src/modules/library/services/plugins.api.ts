import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';

/**
 * Plugin enumeration + join requests — the browser half of the backend's
 * `modules/plugins`.
 *
 * Enumeration is fail-closed with three ordinary access verdicts: a listed
 * plugin is one the caller is a MEMBER of (`canRead`), MANAGES (`canWrite`,
 * admin-rescued), or may DISCOVER (they can read the plugin's `access.md`
 * file — granted by its own `read: everyone` frontmatter). A plugin with no
 * verdict is absent. Asking to join opens a plain change request; nothing
 * request-shaped is stored anywhere else.
 *
 * Every type below MIRRORS the backend contract (`plugins.contract.ts`). Keep
 * them in step.
 */

export interface PluginPrincipals {
  roles: string[];
  users: { name: string; email: string }[];
}

export interface PluginReaders extends PluginPrincipals {
  /** False when `read: everyone` applies cleanly (the lists are then empty). */
  restricted: boolean;
}

export interface PluginSummary {
  /** Plugin folder name, e.g. `GTM`. */
  name: string;
  /** Repo-relative constituent folders, e.g. `['Plugins/GTM']`. */
  folders: string[];
  /** Per-caller: can read the folder (membership). Locked === !canRead. */
  canRead: boolean;
  /** Per-caller; true ⇒ may manage the plugin's access (admin-rescue applies). */
  canWrite: boolean;
  /**
   * Per-caller: holds the `owner` verb on the folder (owner-lists only, no
   * admin rescue). Deleting the plugin is the owner's verb — the DELETE route
   * enforces this same verdict, so it also decides who sees the affordance.
   */
  isOwner: boolean;
  /** The plugin's TOTALS, not the caller's slice. */
  skillCount: number;
  toolCount: number;
  owners: PluginPrincipals;
  writers: PluginPrincipals;
  readers: PluginReaders;
  /** The caller has an OPEN join change request for this plugin. */
  hasRequested: boolean;
  /** That CR's number when `hasRequested` (deep-links the review UI). */
  requestNumber: number | null;
}

export async function listPlugins(): Promise<PluginSummary[]> {
  const res = await authFetch('/api/plugins');
  if (!res.ok) throw new Error("Couldn't load plugins.");
  const data = (await res.json()) as { plugins: PluginSummary[] };
  return data.plugins;
}

/**
 * Create a plugin — the dedicated provisioning endpoint, not a workspace
 * write. The server owns name validation and the collision verdict (its
 * check is against the live tree, ours against a stale catalog), commits the
 * seeded `access.md` before answering, and refuses with its own words —
 * worth surfacing verbatim.
 */
export async function createPlugin(name: string): Promise<{ folder: string }> {
  const res = await authFetch('/api/plugins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't create that plugin.");
  }
  return (await res.json()) as { folder: string };
}

/**
 * Delete a plugin — the whole folder, skills and tools included, in one
 * commit. Owner-gated server-side (the `owner` verdict on the folder); a
 * refusal names the rule and is worth surfacing verbatim. Fail-closed: a
 * plugin the caller doesn't own answers exactly like one that doesn't exist.
 */
export async function deletePlugin(name: string): Promise<void> {
  const res = await authFetch(`/api/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't delete that plugin.");
  }
}

/**
 * Ensure the caller's personal folder (`Plugins/personal-<id>/`) exists.
 * Idempotent; the server answers only after the folder's access.md is
 * COMMITTED, so a write into the folder may follow immediately.
 */
export async function ensurePersonalPlugin(): Promise<{ folder: string; created: boolean }> {
  const res = await authFetch('/api/plugins/personal', { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't prepare your personal folder.");
  }
  return (await res.json()) as { folder: string; created: boolean };
}

/**
 * Thrown when linking is refused because the caller may edit the plugin but
 * not the skill's access rules — the link would share nothing. The UI turns
 * this into "request write access".
 */
export class NeedsSkillWriteError extends Error {
  readonly root: string;
  constructor(root: string) {
    super("You can't change who may read this skill yet.");
    this.name = 'NeedsSkillWriteError';
    this.root = root;
  }
}

async function linkCall(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await authFetch(url, init);
  const body = (await res.json().catch(() => ({}))) as { error?: string; kind?: string; root?: string };
  if (!res.ok) {
    if (body.kind === 'needs-skill-write') throw new NeedsSkillWriteError(body.root ?? '');
    throw new Error(body.error ?? "Couldn't update the plugin's links.");
  }
  return body;
}

/**
 * Link a skill (or a folder of skills) into a plugin: the path goes into the
 * plugin's manifest and the skill's rules grant the plugin's principals. Needs
 * write on both sides — see `NeedsSkillWriteError`.
 */
export async function linkSkill(plugin: string, skillPath: string): Promise<{ root: string; skills: string[] }> {
  return (await linkCall(`/api/plugins/${encodeURIComponent(plugin)}/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skillPath }),
  })) as { root: string; skills: string[] };
}

/** Remove a link. `revoked` says whether the plugin's grant on the skill went with it. */
export async function unlinkSkill(plugin: string, skillPath: string): Promise<{ root: string; revoked: boolean }> {
  return (await linkCall(
    `/api/plugins/${encodeURIComponent(plugin)}/links?skillPath=${encodeURIComponent(skillPath)}`,
    { method: 'DELETE' },
  )) as { root: string; revoked: boolean };
}

/** Re-grant the plugin's principals on a linked skill whose grant was hand-removed. */
export async function repairSkillLink(plugin: string, skillPath: string): Promise<void> {
  await linkCall(`/api/plugins/${encodeURIComponent(plugin)}/links/repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skillPath }),
  });
}

/**
 * Thrown when a join request is refused because access already landed —
 * between the page load and the click. Not an error to show: the right
 * response is to reload the library and let the plugin appear unlocked.
 */
export class AlreadyReadableError extends Error {
  constructor() {
    super('You can already read this plugin');
    this.name = 'AlreadyReadableError';
  }
}

/** Open (or return the existing) join change request. Idempotent server-side. */
export async function requestPluginAccess(name: string): Promise<{ number: number }> {
  const res = await authFetch(`/api/plugins/${encodeURIComponent(name)}/join-request`, {
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
 * Open join requests for a plugin the caller MANAGES, each with what it still
 * proposes. Non-managers get `[]` (never a 403), so the caller may ask
 * unconditionally — the same posture every other plugin surface takes.
 */
export async function listJoinRequests(name: string): Promise<JoinRequest[]> {
  const data = await handleApiResponse<{ requests: JoinRequest[] }>(
    await authFetch(`/api/plugins/${encodeURIComponent(name)}/join-requests`),
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
      `/api/plugins/${encodeURIComponent(name)}/join-requests/${number}/reconcile`,
      { method: 'POST' },
    ),
  );
  return data.closed;
}
