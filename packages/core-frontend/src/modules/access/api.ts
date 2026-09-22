import type { Verb } from '@bevel-software/platform-shared';
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
  // Exactly one separator, as the access grammar has it: a nested name is
  // not a plugin, and showing one would let it be re-submitted as if it were.
  if (cut <= 0 || rest.slice(0, cut).includes('/')) return null;
  const verb = rest.slice(cut + 1).toLowerCase();
  if (!(PLUGIN_PRINCIPAL_VERBS as readonly string[]).includes(verb)) return null;
  return { plugin: rest.slice(0, cut), verb: verb as PluginPrincipalVerb };
}

/** "GTM · readers" — the human spelling of a plugin principal. */
export function pluginPrincipalLabel(plugin: string, verb: PluginPrincipalVerb): string {
  const who = verb === 'read' ? 'readers' : verb === 'write' ? 'writers' : 'owners';
  return `${plugin} · ${who}`;
}

/**
 * A person named in an access list. `hasAccount` is false when nobody has
 * ever signed in as that email — under single sign-on the account is created
 * BY the first sign-in, so a grant written ahead of time is a normal thing to
 * see and is never refused for it. The dialog turns the flag into a quiet
 * "hasn't signed in yet" beside the name, which is what makes a typo visible;
 * the server re-reads it with every view, so the note goes away by itself
 * once that person signs in. Optional for version skew: an older server omits
 * it, and `undefined` must read as "nothing to say", never as "no account".
 */
export interface AccessUser {
  name: string;
  email: string;
  hasAccount?: boolean;
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
  users: AccessUser[];
}

export interface AccessReaders extends AccessEligible {
  /** False when `read: everyone` applies cleanly — the node is public. */
  restricted: boolean;
  /**
   * The PUBLIC plugin principals (`plugin/<name>/read` tokens whose plugin
   * anyone can read) granted read here — why the node is public besides any
   * literal `everyone` line. Optional for version skew.
   */
  publicVia?: string[];
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

/**
 * Where a principal is DENIED one verb, closest-first (mirrors the backend
 * `DenialSources`). `direct` is a `deny` written on the target itself — a
 * restriction made HERE, which the row renders as "restricted here" and whose
 * menu can lift it; `ancestor` is one written in a parent folder.
 *
 * A separate map from {@link GrantSources} on purpose: everything that reads
 * `sources` means "where their access comes from" and filters on
 * `direct`/`ancestor` with no polarity check, so a denial mixed in there would
 * be counted as a grant. Only DENIED verbs appear; absent under version skew.
 */
export type DenialSources = Partial<Record<GrantVerb, VerbSources>>;

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
  /**
   * Per-principal, per-verb DENIALS, keyed exactly like `sources`. Only
   * principals with at least one denied verb appear. This is what lets a row
   * say "restricted here" instead of silently showing a verb as off, and what
   * makes a restriction liftable from the same menu that wrote it.
   *
   * Optional for version skew: an older server omits it and every row simply
   * renders no restrictions.
   */
  denials?: Record<string, DenialSources>;
  /**
   * The principals this target RESTRICTS — everyone named by a `deny` in its
   * own access file. They are in no eligible list (a principal denied every
   * verb holds nothing), so without this list the row would vanish the moment
   * the restriction was written: the bug this field exists to close.
   *
   * Shaped like an eligible list so rows build from it through the same path.
   * No legacy name-only `roles` twin: this list is new, so nothing reads it
   * kind-blind. Optional for version skew.
   */
  deniedHere?: {
    principals: ResolvedPrincipal[];
    /** Restricted here; each carries {@link AccessUser.hasAccount} like a holder does. */
    users: AccessUser[];
  };
  /**
   * Present for a file that cannot carry frontmatter (a PDF, a deck, an
   * image — or binary bytes saved under a note's name, which the server
   * judges by reading them): the repo-relative folder (`''` for the root)
   * whose rules govern it. Such a file has no per-file rules, and the
   * mutation routes refuse it with `folder-governs-access`. This is the
   * server's ruling, and the dialog follows it rather than re-deciding from
   * the path, so the sheet and the routes can never disagree.
   */
  governedByFolder?: string;
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

/** Verbs the share dialog can grant — the grammar's own list, from `platform-shared`. */
export type GrantVerb = Verb;

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
  /**
   * Matching people, each carrying {@link AccessUser.hasAccount} — false for
   * someone named in the knowledge base who has never signed in. Nobody is
   * withheld for it; it is what a chip made from the suggestion labels itself
   * with.
   */
  people?: AccessUser[];
  /** True when the query was too short to return people (roles/groups still shown). */
  peopleWithheld?: boolean;
  /**
   * True when THIS ANSWER rules on accounts — every person above carries
   * {@link AccessUser.hasAccount}, and an address missing from `people` is
   * missing because no account exists for it.
   *
   * It describes the answer, not the build, and so is false whenever
   * `peopleWithheld` is true: a query too short to return anybody says
   * nothing about whether anybody has an account. Absent means the server
   * said nothing on the subject at all (an older build), and a failed request
   * says nothing either. The dialog labels a free-typed chip "hasn't signed
   * in yet" only on this evidence — and checks `peopleWithheld` alongside it,
   * so the two can never be read apart — so silence never becomes an
   * accusation that an address is wrong.
   */
  accountsKnown?: boolean;
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
 * Batch lookup — one round trip resolves one verb for multiple paths: write
 * permission by default, or `owner` — membership in an `owner:` grant, which
 * a writer (an Admin included) does not have by writing.
 * Caller-supplied path strings are the keys of the returned record. Throws if
 * any path is rejected by the backend.
 */
export async function fetchFileAccessBatch(
  workspaceId: string,
  relativePaths: string[],
  verb: 'write' | 'owner' = 'write',
): Promise<{ results: Record<string, boolean> }> {
  return handleApiResponse(
    await authFetch(`/api/workspace/${workspaceId}/access/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The default goes unsent, so a write lookup is the request it always was.
      body: JSON.stringify(verb === 'write' ? { paths: relativePaths } : { paths: relativePaths, verb }),
    }),
  );
}

/**
 * A principal as its grant names it — a group, a role, a plugin principal
 * (spelled as its `plugin/<Name>/<verb>` token), or a person granted
 * directly. What the prospective-access lists are made of.
 */
export interface AccessPrincipalRef {
  kind: 'group' | 'role' | 'plugin' | 'person';
  name: string;
  email?: string;
}

/** Who can open and who can edit one path. */
export interface PathPrincipals {
  read: AccessPrincipalRef[];
  write: AccessPrincipalRef[];
}

/** One file's holders where it is now and where a move would put it. */
export interface ProspectiveAccess {
  before: PathPrincipals;
  after: PathPrincipals;
}

/**
 * Resolve who holds read and write on `relativePath` today and who would hold
 * them once the file sits in `toDir` — the destination's folder rules with the
 * file's own frontmatter layered on top. Both paths are repo-relative
 * (`Knowledge/Foo.md`, `Knowledge/Sales`); `toDir` is `''` for the repo root.
 *
 * `signal` lets the move dialog give up on it: the answer decorates the
 * confirmation and must never hold it open.
 */
export async function fetchProspectiveAccess(
  workspaceId: string,
  relativePath: string,
  toDir: string,
  signal?: AbortSignal,
): Promise<ProspectiveAccess> {
  const query = `from=${encodeURIComponent(relativePath)}&toDir=${encodeURIComponent(toDir)}`;
  return handleApiResponse(
    await authFetch(`/api/workspace/${workspaceId}/access/prospective?${query}`, { signal }),
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

