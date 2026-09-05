import { authFetch } from '../../lib/api';
import { GitApiError, handleApiResponse } from '../git/services/git.api';

/**
 * A collective grantee with WHAT it is — role (capability), group (audience),
 * or plugin (everyone holding a verb on a plugin folder: the name is the
 * `plugin/<Name>/<verb>` token).
 */
export interface ResolvedPrincipal {
  name: string;
  kind: 'role' | 'group' | 'plugin';
}

/** The verbs a plugin principal can stand for — each is its own grantee. */
export type PluginPrincipalVerb = 'read' | 'write' | 'owner';
export const PLUGIN_PRINCIPAL_VERBS: readonly PluginPrincipalVerb[] = ['read', 'write', 'owner'];

/** How a plugin principal is spelled in access rules and resolver output. */
export function pluginPrincipalToken(plugin: string, verb: PluginPrincipalVerb): string {
  return `plugin/${plugin}/${verb}`;
}

/** The parts of a `plugin/<Name>/<verb>` token, or null when it is not one. */
export function parsePluginPrincipalToken(
  token: string,
): { plugin: string; verb: PluginPrincipalVerb } | null {
  if (!token.toLowerCase().startsWith('plugin/')) return null;
  const rest = token.slice('plugin/'.length);
  const cut = rest.lastIndexOf('/');
  if (cut <= 0) return null;
  const verb = rest.slice(cut + 1).toLowerCase();
  if (!(PLUGIN_PRINCIPAL_VERBS as readonly string[]).includes(verb)) return null;
  return { plugin: rest.slice(0, cut), verb: verb as PluginPrincipalVerb };
}

/** "GTM · readers" — the human spelling of a plugin principal. */
export function pluginPrincipalLabel(plugin: string, verb: PluginPrincipalVerb): string {
  const who = verb === 'read' ? 'readers' : verb === 'write' ? 'writers' : 'owners';
  return `${plugin} · ${who}`;
}

export interface AccessEligible {
  /**
   * Kinded twin of `roles` — the same names, each saying whether it is a ROLE
   * or a GROUP, so grantee rows can badge honestly and round-trip mutations
   * with the right principal kind. Optional for version skew: an older server
   * omits it, and readers fall back to `roles` (all treated as roles).
   */
  principals?: ResolvedPrincipal[];
  roles: string[];
  users: { name: string; email: string }[];
}

export interface AccessReaders extends AccessEligible {
  /** False when `read: everyone` applies cleanly (the lists are then empty). */
  restricted: boolean;
}

/**
 * ONE place a principal is named for a verb (mirrors the backend `GrantSource`).
 * Both kinds are file-backed and removable from the dialog: `direct` → remove
 * here; `ancestor` → remove-from-parent or deny-here. A principal who only
 * resolves via a role / group / `everyone` / admin-rescue produces no source.
 */
export type GrantSource =
  | { kind: 'direct' }
  | { kind: 'ancestor'; path: string };

/**
 * EVERY scope that grants a principal one verb, ordered **closest-first**: `[0]`
 * is the effective source, the rest are scopes that ALSO grant it. So a verb
 * granted both on the target and a parent reads `[direct, ancestor]` — letting
 * the dialog tell "granted here" apart from "granted here AND also inherited"
 * (which a single winning source can't). Never empty (a verb with no grant is
 * omitted from `GrantSources`).
 */
export type VerbSources = GrantSource[];

/** Per-verb sources of a principal's access; only held verbs appear. */
export type GrantSources = Partial<Record<GrantVerb, VerbSources>>;

export interface AccessResponse {
  /** True iff the current user may read the path (default-deny). */
  canRead: boolean;
  canWrite: boolean;
  canDownload: boolean;
  /** True iff the current user is an owner of the path (owner ⊇ write + download). */
  canOwner: boolean;
  /** Principals with write at this path (owners folded in). */
  eligible: AccessEligible;
  /** Who can read this path. `restricted: false` ⇒ everyone. */
  readers: AccessReaders;
  /** The owner set for this path — who to contact about the node. */
  owners: AccessEligible;
  /** Principals with `download` at this path (owners folded in; write is NOT). */
  downloaders: AccessEligible;
  /**
   * Per-principal, per-verb sources of access. Keyed `u:<email>` / `r:<role>`
   * / `g:<group>` (lowercased) to match the dialog's row keys, so a row can
   * show where its access comes from (direct, inherited, or both) and which
   * verbs are removable here. Groups have their own `g:` namespace — a group
   * and a role sharing a name are different principals with different
   * sources (older servers keyed groups under `r:`; readers fall back). After
   * a revoke, a principal whose direct entry was stripped but who remains
   * inherited still appears here with only their `ancestor` source(s) — which
   * is how the dialog chains into "Remove from parent?".
   */
  sources: Record<string, GrantSources>;
}

/**
 * The 409 body the revoke route returns when a principal's access on the
 * target is inherited (the target splice would no-op but they still resolve).
 * The dialog turns this into the "Remove from parent?" confirmation.
 */
export interface InheritedRevokeError {
  kind: 'inherited';
  error: string;
  sources: GrantSources;
}

/** Narrow a thrown API error to the inherited-revoke 409 payload, else null. */
export function asInheritedError(err: unknown): InheritedRevokeError | null {
  if (
    err instanceof GitApiError &&
    err.status === 409 &&
    err.body &&
    typeof err.body === 'object' &&
    (err.body as { kind?: unknown }).kind === 'inherited'
  ) {
    return err.body as InheritedRevokeError;
  }
  return null;
}

/**
 * A grantable principal — a person (by email), a role (an app-defined
 * capability from the registry, or a legacy roles.yaml role), or a group (a
 * people-set from the active group source — IdP-synced or manual). Groups are
 * written as bare-name tokens (bare names resolve group-first); the backend
 * writes role grants as explicit `role/<Name>` tokens itself — the dialog
 * just sends `kind: 'role'`. The separate kinds exist so the backend
 * validates each against the right namespace.
 */
export type Principal =
  | { kind: 'user'; email: string; displayName: string }
  | { kind: 'role'; role: string }
  | { kind: 'group'; group: string }
  /** Everyone holding `verb` on the plugin folder — written as `plugin/<Name>/<verb>`. */
  | { kind: 'plugin'; plugin: string; verb: PluginPrincipalVerb };

/** Verbs the share dialog can grant. */
export type GrantVerb = 'read' | 'write' | 'owner' | 'download';

/**
 * The suggest payload. Every field is read DEFENSIVELY (`?.` / `?? []`) in
 * the dialog: under version skew a server may omit one, and a missing field
 * must degrade to an empty section, never a crash. (The retired `plugins`
 * alias of `roles` is deliberately NOT in this type — nothing may read it.)
 */
export interface SuggestResponse {
  /** Role principals (registry roles + legacy roles.yaml roles + `Everyone`). */
  roles?: string[];
  /** Active-source groups. A name shared with a role is offered as BOTH. */
  groups?: string[];
  /**
   * Plugin FOLDER names the caller can discover; each stands for three
   * grantable principals (`plugin/<Name>/read|write|owner`). Not `plugins`,
   * which was the retired alias of `roles`.
   */
  pluginPrincipals?: string[];
  people?: { name: string; email: string }[];
  /** True when the query was too short to return people (roles/groups still shown). */
  peopleWithheld?: boolean;
}

/**
 * Autocomplete the share dialog: matching roles + groups + people. People are
 * withheld until the query is ≥ 2 chars (server-side harvesting guard).
 */
export async function suggestPrincipals(
  workspaceId: string,
  query: string,
): Promise<SuggestResponse> {
  return handleApiResponse(
    await authFetch(
      `/api/workspace/${workspaceId}/access/suggest?q=${encodeURIComponent(query)}`,
    ),
  );
}

/**
 * Grant a principal a verb on a path. `kind` distinguishes a folder target
 * (edits the folder's access.md) from a file target (edits the node's own
 * frontmatter). Returns the fresh resolved access for the path.
 */
export async function grantAccess(
  workspaceId: string,
  input: { path: string; kind: 'folder' | 'file'; verb: GrantVerb; principal: Principal },
): Promise<AccessResponse> {
  return handleApiResponse(
    await authFetch(`/api/workspace/${workspaceId}/access/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

/**
 * Revoke a principal from a path. Three shapes:
 *   - default (no `mode`): remove the principal's DIRECT grant on the target
 *     (with `verb`, just that verb). If their access is inherited, the server
 *     responds 409 `{ kind: 'inherited', sources }` — use `asInheritedError`.
 *   - `mode: 'remove-from-parent'` + `ancestor`: cascade up — remove them from
 *     the granting ancestor folder (echo the ancestor path from the 409 sources
 *     verbatim; it's an opaque repo-relative token).
 *   - `mode: 'deny-here'`: per-item override — add a `deny` at the target only.
 * Returns the fresh resolved access on success.
 */
export async function revokeAccess(
  workspaceId: string,
  input: {
    path: string;
    kind: 'folder' | 'file';
    principal: Principal;
    verb?: GrantVerb;
    mode?: 'remove-from-parent' | 'deny-here';
    ancestor?: string;
  },
): Promise<AccessResponse> {
  return handleApiResponse(
    await authFetch(`/api/workspace/${workspaceId}/access/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

/**
 * Resolve write permission for a single file under the current user's identity
 * in the given workspace.
 *
 * `relativePath` is repo-relative (`Knowledge/Foo.md`, not `knowledge-base/…`).
 * UI callers that hold workspace-relative paths should go through
 * `useFileAccess`, which strips the `kbDirName/` prefix and short-circuits for
 * paths outside the KB repo.
 */
export async function fetchFileAccess(
  workspaceId: string,
  relativePath: string,
  kind: 'folder' | 'file' = 'file',
): Promise<AccessResponse> {
  return handleApiResponse(
    await authFetch(
      `/api/workspace/${workspaceId}/access?path=${encodeURIComponent(relativePath)}&kind=${kind}`,
    ),
  );
}

/**
 * Batch lookup — one round trip resolves write permission for multiple paths.
 * Caller-supplied path strings are the keys of the returned record. Throws if
 * any path is rejected by the backend.
 */
export async function fetchFileAccessBatch(
  workspaceId: string,
  relativePaths: string[],
): Promise<{ results: Record<string, boolean> }> {
  return handleApiResponse(
    await authFetch(`/api/workspace/${workspaceId}/access/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: relativePaths }),
    }),
  );
}

/** A principal named by a rule, as the overrides endpoint reports it. */
export type AccessOverridePrincipal =
  | { kind: 'role'; role: string }
  | { kind: 'user'; email: string; name: string }
  | { kind: 'everyone' };

/** One `verb: principal` line of a rule; `deny` mirrors the literal prefix. */
export interface AccessOverrideEntry {
  verb: GrantVerb;
  deny: boolean;
  principal: AccessOverridePrincipal;
}

/**
 * A file INSIDE a folder that declares its own access rules — a descendant
 * `access.md` or a node's own frontmatter. `path` is the file that declares;
 * `governs` is what the rules apply to (the containing directory for an
 * `access.md`, the file itself for frontmatter). `parseError` is set, with
 * `entries: []`, when an `access.md` could not be parsed.
 */
export interface AccessOverride {
  path: string;
  governs: string;
  source: 'access-md' | 'frontmatter';
  entries: AccessOverrideEntry[];
  parseError?: string;
}

/**
 * Every access rule declared inside `folder` (repo-relative). Display-only: a
 * folder's share list is not the whole story, because resolution is
 * closeness-first and a rule written on one item overrides the folder's rule
 * for the principals it names.
 *
 * 403s for a caller who cannot read the folder, and drops rows governing
 * anything they cannot read — so this can only ever describe rules on things
 * the caller already sees.
 */
export async function fetchAccessOverrides(
  workspaceId: string,
  folder: string,
): Promise<{ overrides: AccessOverride[]; truncated: boolean }> {
  return handleApiResponse(
    await authFetch(
      `/api/workspace/${workspaceId}/access/overrides?path=${encodeURIComponent(folder)}`,
    ),
  );
}

