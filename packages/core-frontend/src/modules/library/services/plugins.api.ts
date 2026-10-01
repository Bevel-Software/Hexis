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
  /** The plugin's identity — its manifest name, e.g. `gtm`. Grants, URLs and the marketplace spell it. */
  name: string;
  /** What people see it called, e.g. `GTM`. Absent from an older server: show `name`. */
  displayName?: string;
  /** Repo-relative constituent folders, e.g. `['Plugins/GTM']`. */
  folders: string[];
  /**
   * Repo-relative roots the plugin LINKS skills from, e.g. `['Skills/Testing']`.
   *
   * What lets the plugin's page tell a card that LIVES here from one it only
   * points at. A skill says so itself (`PluginMembership.linked`); a tool
   * says nothing — a `.tool` beside the skills under a linked root reaches
   * the plugin the same way they do, and only these roots reveal it. Absent
   * from an older server: every tool then reads as inline, which is what the
   * page showed before.
   */
  linkedRoots?: string[];
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
  /**
   * Whether this platform writes the plugin's links (a native manifest).
   * False for a plugin read from an external format — its links are edited
   * in that repository, and the link endpoints refuse it. Absent from an
   * older server, which knew only managed plugins.
   */
  linksAreManaged?: boolean;
  /** The plugin's TOTALS, not the caller's slice. */
  skillCount: number;
  toolCount: number;
  /**
   * How many of the plugin's linked skills its members cannot read, counted
   * by the server from the unfiltered link index — so a manager the missing
   * grant locks out of the skill still sees the count. Absent from an older
   * server: fall back to what the caller's own catalog shows.
   */
  brokenLinks?: number;
  owners: PluginPrincipals;
  writers: PluginPrincipals;
  readers: PluginReaders;
  /**
   * The plugin's access.md says of itself that it is private: its
   * frontmatter denies `everyone` and names nobody but people — a personal
   * space's shape, or a plugin kept to a few named colleagues. Shown as a
   * "Private" mark on the row. Absent from an older server.
   */
  isPrivate?: boolean;
  /**
   * What the platform left out of this plugin's definition and why, in
   * plain words — an MCP server its profile selects that could not be kept,
   * a skill root that is not a folder. Shown on the plugin's page, counted
   * as attention on its row. Absent from an older server.
   */
  warnings?: string[];
  /**
   * The caller has asked to join this plugin — true from the moment the
   * server records the ask, which is before the change request that carries
   * it exists. That is what keeps the "Requested" card on the page through a
   * reload while the server is still doing the git work.
   */
  hasRequested: boolean;
  /** The join CR's number once it exists (deep-links the review UI); null before that. */
  requestNumber: number | null;
  /**
   * Why the recorded request could not be sent, in the server's words — set
   * only when `hasRequested` is false because it failed. Absent from an older
   * server, and absent whenever there is nothing to say.
   */
  requestFailure?: string | null;
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
/**
 * Make a plugin. `parent` is a grouping folder below the plugins root to
 * make it in (`Teams`, `Teams/EU`); omitted or empty, it goes at the root.
 * The server owns every rule about where a plugin may go.
 *
 * The answer carries both names as the manifest now holds them: the identity
 * the endpoint derived, and the display name — the typed name, trimmed —
 * that was written into the file.
 */
export async function createPlugin(
  name: string,
  parent = '',
): Promise<{ folder: string; name: string; displayName: string }> {
  const res = await authFetch('/api/plugins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parent ? { name, parent } : { name }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't create that plugin.");
  }
  return (await res.json()) as { folder: string; name: string; displayName: string };
}

/**
 * Rename a plugin: its identifier (which rewrites every grant naming it),
 * its display name, or both. The refusal's message names the reason — a
 * taken name, a bad identifier, files the caller cannot edit.
 */
export async function renamePlugin(
  name: string,
  patch: { name?: string; displayName?: string },
): Promise<{ name: string; displayName: string; rewritten: string[] }> {
  const res = await authFetch(`/api/plugins/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't rename the plugin.");
  }
  return (await res.json()) as { name: string; displayName: string; rewritten: string[] };
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

/** Who may edit a skill root's access file — who can repair its link. */
export interface LinkEditors {
  roles: string[];
  users: { name: string; email: string }[];
}

/** One link the page-open repair left alone, and why — mirrors the backend. */
export interface UnrepairedLink {
  /** Repo-relative root, as the plugin's manifest declares it. */
  root: string;
  /**
   * `needs-skill-write` — the viewer may not write its access file; `failed`
   * — the write did not land; `denied` — the lines are there and a `deny` of
   * the plugin beside them keeps the link broken, so there is nothing to
   * write and only an editor removing the deny would change it.
   */
  reason: 'needs-skill-write' | 'failed' | 'denied';
  /** The skills the plugin's members still cannot read through it. */
  skills: { path: string; name: string }[];
  /** Who the banner names as able to repair it. */
  editors: LinkEditors;
}

/** What one page-open repair did, and what is still broken. */
export interface LinkRepairReport {
  repaired: string[];
  skipped: UnrepairedLink[];
}

/**
 * Repair every link of a plugin whose grants are missing — what the plugin
 * page runs, once, on open, for someone who may write the plugin.
 *
 * Silent by design: a repaired link shows nothing, so the only thing the
 * caller does with `repaired` is reload the catalog. `skipped` is the banner.
 * Refused with the ordinary 404 for a caller who may not write the plugin,
 * which is why the page asks only when its summary says they can.
 */
export async function repairPluginLinks(plugin: string): Promise<LinkRepairReport> {
  const body = await linkCall(`/api/plugins/${encodeURIComponent(plugin)}/links/repair-all`, {
    method: 'POST',
  });
  return body as unknown as LinkRepairReport;
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

/**
 * Ask to join a plugin. The server RECORDS the ask and answers — the branch,
 * the clone, the grant commit, the push and the change request happen after,
 * so this resolves in a round-trip rather than in however long a first clone
 * takes. `state` says which: `pending` while the git work is still to come,
 * `opened` when the change request already exists (a second click, a retry
 * the server had already finished), in which case `number` is that request's.
 *
 * Idempotent server-side, and by the recorded request rather than by the
 * branch: two tabs or two clicks record one request and open one change
 * request, and a click after a failure continues the recorded one.
 */
export async function requestPluginAccess(
  name: string,
): Promise<{ state: 'pending' | 'opened'; number: number | null }> {
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
  return handleApiResponse<{ ok: true; state: 'pending' | 'opened'; number: number | null }>(res);
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
