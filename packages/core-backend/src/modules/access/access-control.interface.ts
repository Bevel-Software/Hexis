/**
 * Access-control service interface. The implementation reads `roles.yaml`,
 * the active group file (`synced-groups.yaml` / `groups.yaml`), and the
 * `access.md` tree from the workspace's `knowledge-base` clone and resolves
 * the access verbs (read / write / download / owner) against them.
 *
 * All `relativePath` arguments are repo-relative POSIX paths inside the KB
 * repo (e.g. `Knowledge/Sales/Foo.md`, `roles.yaml`) — NOT workspace-relative
 * (the workspace contains `knowledge-base/` and other reserved files).
 */
/**
 * ONE place a principal is NAMED for a verb — the unit a Remove acts on. The
 * source answers exactly one question — WHICH FILE holds this entry — and is MECE
 * over the two editable locations:
 *   - `direct`   — the principal is named in the target's own access file (the
 *                  file's frontmatter, or the folder's own `access.md`).
 *                  Removable in place.
 *   - `ancestor` — the principal is named in a parent folder's `access.md` at
 *                  `path` (repo-relative). Removable by editing that ancestor
 *                  (cascade up) or by a `deny` at the target.
 *
 * Only a principal NAMED in a file (a direct user grant `Name <email>`, or a
 * group/role token) produces sources. A USER who merely RESOLVES to access via a
 * group or role they belong to, the built-in `everyone`, or admin-rescue is NOT a
 * per-target file entry and produces NO source (the group/role itself shows as its own
 * row instead).
 */
export type GrantSource =
  | { kind: 'direct' }
  | { kind: 'ancestor'; path: string };

/**
 * EVERY scope that grants a principal one verb, ordered **closest-first** — so
 * `[0]` is the effective (winning) source and the rest are scopes that ALSO grant
 * it. This is deliberately not collapsed to the winner: "can they?" needs only
 * the closest scope, but "where would I edit to fully remove them?" needs all of
 * them, and the share dialog needs to tell "granted here" apart from "granted
 * here AND also inherited from a parent" (which a single winning source cannot —
 * both would read `direct`). Callers collapse as they need: the winner is `[0]`,
 * removability-here is `[0].kind === 'direct'`, the still-inherited remainder
 * after removing a direct grant is the `ancestor` entries in the tail. Never
 * empty (a verb with no grant is omitted from `GrantSources` entirely).
 */
export type VerbSources = GrantSource[];

/** Whether the dialog target is a folder or a file — mirrors the mutation side. */
export type AccessTargetKind = 'folder' | 'file';

/** A principal in the resolver's canonical terms (mirrors `access-splice.ts`). */
export type GrantPrincipal =
  | { kind: 'user'; email: string }
  | { kind: 'role'; role: string };

/**
 * One collective principal in a resolved eligible list, with WHAT it is: a
 * ROLE (an app-defined capability) or a GROUP (a grant audience from the
 * active group source). The resolver knows the kind from the merged principal
 * index — a `role/<canonical>` alias hit is always the role; a bare token is
 * whatever owns it under group-first precedence — and the share dialog needs
 * it to badge each grantee row honestly ("Role" vs "Group") and to round-trip
 * the row's principal with the right kind.
 *
 * Additive: `principals` rides NEXT TO the legacy `roles: string[]` (the same
 * names, kind erased), which many name-only consumers (banners, owner
 * contact lines, PR-routing messages) still read. It is optional in the
 * interface so existing test doubles stay valid; the real service always
 * returns it, and payload consumers fall back to `roles` (all treated as
 * roles) when absent.
 */
export type ResolvedPrincipal = { name: string; kind: 'role' | 'group' | 'plugin' };

/**
 * The principals holding ONE verb at one path, in the shape every `eligible*`
 * lookup answers in: the kinded collectives, the same names with their kind
 * erased (for the name-only consumers), and the directly granted people.
 */
export type HolderList = {
  principals?: ResolvedPrincipal[];
  roles: string[];
  users: { name: string; email: string }[];
};

/** Who can open and who can edit one path — the two verbs a move compares. */
export type PathHolders = { read: HolderList; write: HolderList };

/**
 * One file's holders where it is now and where a move would put it — see
 * {@link IAccessControl.prospectiveHolders}.
 */
export type ProspectiveHolders = { before: PathHolders; after: PathHolders };

/**
 * Per-verb sources of a principal's access on a target. Only verbs the principal
 * actually holds (via a named file entry) appear; each maps to the closest-first
 * list of scopes that grant it (see `VerbSources`). A principal with no named
 * grant at all yields an empty map.
 */
export type GrantSources = Partial<Record<'read' | 'write' | 'download' | 'owner', VerbSources>>;

/**
 * ONE place a principal is DENIED a verb — the mirror of {@link GrantSource},
 * over the same two editable locations: `direct` is a `deny` written in the
 * target's OWN access file (a restriction made HERE), `ancestor` one written in
 * a parent folder's `access.md` at `path`.
 *
 * A denial is a first-class entry, not the absence of a grant: it is what
 * "restrict just this folder" writes, and the share dialog has to render it —
 * otherwise a principal whose only entry here is a denial reads as ungoverned
 * by this target and drops out of its "on this folder" list.
 */
export type DenialSource = GrantSource;

/**
 * EVERY scope that DENIES a principal one verb, ordered **closest-first**, up
 * to (but not including) a closer own GRANT — which beats a farther deny under
 * closest-wins and makes it dead. `[0]` is the effective denial. Only verbs the
 * principal is actually denied appear; a verb with no denial is omitted.
 *
 * Deliberately a SEPARATE map from {@link GrantSources} rather than extra
 * entries in it: every existing reader of `GrantSources` means "where their
 * access comes from" and filters on `direct` / `ancestor` with no polarity
 * check, so a denial smuggled in there would be read as a grant.
 */
export type DenialSources = Partial<
  Record<'read' | 'write' | 'download' | 'owner', DenialSource[]>
>;

/**
 * Where one verdict was decided, repo-relative: a folder's rules (its
 * `access.md`; `''` is the repo root) or a file's own frontmatter.
 * `inherited` is true when that place is not the target's own — an ancestor
 * folder's rules — and false for the target's own frontmatter or, for a folder
 * target, its own `access.md`.
 */
export type AccessDecisionSource = {
  kind: 'folder' | 'frontmatter';
  path: string;
  inherited: boolean;
};

/**
 * ONE caller's verdict on one verb, with its reason — what `canRead` /
 * `canWrite` / `canDownload` / `canOwner` answer, explained. `source` is null
 * when no access rule decided it: the admin rescue on `access.md` /
 * `roles.yaml`, a machine-owned file, or default-deny (nothing grants it).
 * `via` names the tier that matched and `principal` the display name of the
 * group, role or plugin principal it matched on (the caller's own email for
 * `person`, `everyone` for the built-in). `admin-floor` is Admin's write at
 * the repository root, which no rule there can take away; its source is the
 * root's rules, or null when the root has none.
 */
export interface AccessDecision {
  allowed: boolean;
  source: AccessDecisionSource | null;
  via:
    | 'person'
    | 'group'
    | 'role'
    | 'plugin'
    | 'everyone'
    | 'admin-rescue'
    | 'admin-floor'
    | 'machine-owned'
    | 'default-deny';
  principal: string | null;
}

export interface IAccessControl {
  /** True iff `userEmail` has `write` on `relativePath` per the current access tree. */
  canWrite(workspaceId: string, userEmail: string, relativePath: string): Promise<boolean>;

  /**
   * True iff `userEmail` may READ `relativePath` per the current access tree.
   *
   * `read` is **default-deny**: a path with no effective `read:`, `write:`,
   * `download:` or `owner:` grant is not readable. To make content public,
   * declare the built-in role `everyone` under `read:`. Resolution is
   * closeness-first then tier (email > role > everyone within a scope), folding
   * `write:`/`download:`/`owner:` in as implicit read grants (grant-only — a
   * write/download/owner denial never strips a read grant). No admin rescue.
   * The file viewer, embed surface, and the agent's read tools all gate on this.
   */
  canRead(workspaceId: string, userEmail: string, relativePath: string): Promise<boolean>;

  /**
   * Batched `canRead` — one config load per call, same default-deny semantics,
   * INCLUDING each node's own frontmatter `read:` rules. Per-file frontmatter
   * reads are memoized per workspace (dropped on `invalidate`, TTL-bounded),
   * so the file-explorer tree — which resolves every KB file on each load —
   * uses this too: a file the caller can't read (whether the rule lives in a
   * folder `access.md` or in the file's own frontmatter) never appears in the
   * tree, matching what the content routes will enforce on open.
   */
  canReadBatch(
    workspaceId: string,
    userEmail: string,
    relativePaths: string[],
  ): Promise<Map<string, boolean>>;

  /**
   * Batched read for a GROUP rather than a person: what being in `group`
   * (a `groups.yaml` display name, or the active group source's) confers on
   * each path, through the same closeness-first walk `canReadBatch` runs —
   * the group's own key, every role that lists the group, every plugin
   * principal whose roster the group is part of, and the public keys every
   * caller holds. No person is involved, so nothing a member holds for a
   * reason of their own (a direct `Name <email>` grant, another role,
   * deployment ownership) counts, and no admin rescue applies.
   *
   * `null` when no such group exists — distinct from a map of `false`s,
   * which is a real group that can read none of the paths.
   */
  canReadAsGroupBatch(
    workspaceId: string,
    group: string,
    relativePaths: string[],
  ): Promise<Map<string, boolean> | null>;

  /**
   * Batched read for EVERYONE — what a signed-in person who is in no group
   * and holds no role reads on each path, through the same walk. This is
   * the built-in `everyone` principal's own verdict: a `read: everyone`
   * grant (or a public plugin's) at the closest scope that says anything,
   * a `deny everyone` there withholds. Nothing person-shaped counts — no
   * email entry, no role, no admin rescue — so the answer is what the
   * organisation as a whole can use, which is what the "Everyone" lens
   * lists.
   */
  canReadAsEveryoneBatch(workspaceId: string, relativePaths: string[]): Promise<Map<string, boolean>>;

  /**
   * Batched canWrite for PR diffs and commit-time gating. Returns a map keyed
   * by the input paths, with `true` / `false` for each. Reuses one config
   * load per call.
   */
  canWriteBatch(
    workspaceId: string,
    userEmail: string,
    relativePaths: string[],
  ): Promise<Map<string, boolean>>;

  /**
   * True iff `userEmail` has `download` permission on `relativePath` per
   * the current access tree. Resolution mirrors `canWrite`: walks repo
   * root → file directory, accumulates per-principal state from each
   * `access.md`'s `download:` list. Independent of `write` — granting
   * write does NOT imply download, mirroring the way the verbs are
   * separately listed in access.md. An `owner:` grant DOES imply download
   * (owner is a superset of write + download). The reverse fold holds one
   * level down: a `download:` grant confers `read` (see `canRead`), so a
   * download-only grantee can open the file as well as save it.
   *
   * No admin override (unlike `canWrite` on `access.md` / `roles.yaml`,
   * which admin-rescues). Admins are only granted download if an
   * access.md explicitly lists them (directly or as an owner).
   */
  canDownload(
    workspaceId: string,
    userEmail: string,
    relativePath: string,
  ): Promise<boolean>;

  /**
   * True iff `userEmail` is an `owner` of `relativePath` per the current
   * access tree, resolved from the `owner:` lists alone (the `write` /
   * `download` lists do NOT confer ownership — only the reverse holds).
   *
   * Ownership is a superset of write + download AND a contact designation:
   * owners can do everything writers can (edit, approve / reject change
   * requests, appear in the affected-owners block) and are surfaced in the
   * UI so users know who to contact for more information on a node.
   */
  canOwner(
    workspaceId: string,
    userEmail: string,
    relativePath: string,
  ): Promise<boolean>;

  /**
   * Batched `canOwner` — one config load per call, same `owner:`-lists-only
   * resolution (no admin rescue). Used by plugin enumeration to answer "which
   * of these folders does the caller own?" without one model load per plugin.
   */
  canOwnerBatch(
    workspaceId: string,
    userEmail: string,
    relativePaths: string[],
  ): Promise<Map<string, boolean>>;

  /**
   * The set of principals (roles + direct users) that own this path — i.e.
   * who to contact about it. Resolved from `owner:` lists only. Used by the
   * file viewer to render the "owners / contact" affordance.
   */
  eligibleOwners(
    workspaceId: string,
    relativePath: string,
  ): Promise<{
    principals?: ResolvedPrincipal[];
    roles: string[];
    users: { name: string; email: string }[];
  }>;

  /**
   * The set of principals (roles + direct users) with `write` on this path.
   * Used by PR reviewer routing and the per-file approval UI to render
   * "who can approve this file". Owners are included here — an `owner:`
   * grant confers write, so owners can approve / reject the same files
   * writers can.
   */
  eligibleWriters(
    workspaceId: string,
    relativePath: string,
  ): Promise<{
    principals?: ResolvedPrincipal[];
    roles: string[];
    users: { name: string; email: string }[];
  }>;

  /**
   * Answers the file viewer's "who can see this?" affordance. `restricted` is
   * false only when `read: everyone` applies without an effective user-level
   * denial — the node is readable by all signed-in users. The lists name the
   * principals (roles + direct users) granted read whether or not the node
   * is public, with writers, downloaders and owners folded in (a `write:`,
   * `download:` or `owner:` grant confers read); on a public node they
   * include what makes it public. `publicVia` names the
   * PUBLIC plugin principals granted read here — principals every signed-in
   * user holds — so a caller can tell public-through-a-plugin from a literal
   * `everyone` grant. The lists may be empty for a default-denied path.
   */
  eligibleReaders(
    workspaceId: string,
    relativePath: string,
  ): Promise<{
    restricted: boolean;
    principals?: ResolvedPrincipal[];
    roles: string[];
    users: { name: string; email: string }[];
    publicVia?: string[];
  }>;

  /**
   * The set of principals (roles + direct users) with `download` on this path.
   * Resolved from the `download:` lists with owners folded in — an `owner:`
   * grant confers download (owner ⊇ download), but `write` does NOT (download
   * is independent of write). The lists may be empty for a path with no
   * download grant. Used by the share UI to render the per-principal download
   * checkbox.
   */
  eligibleDownloaders(
    workspaceId: string,
    relativePath: string,
  ): Promise<{
    principals?: ResolvedPrincipal[];
    roles: string[];
    users: { name: string; email: string }[];
  }>;

  /**
   * Who can open and who can edit one file where it IS, and where a move
   * would put it. `toPath` names a path that does not exist yet — the point
   * of the call is to answer before the move happens — so the resolution
   * layers the file's OWN rules (its frontmatter, read from `fromPath`,
   * which travels with the bytes) over the destination's folder chain.
   *
   * Writes nothing and moves nothing. The move confirmation diffs the two
   * sides to name who loses and who gains access.
   *
   * A FILE question only: a `fromPath` that is a directory is refused with a
   * 400. A folder's access is its own `access.md` — which moves with it and
   * governs everything beneath it — so resolving it as a file would name the
   * wrong principals with the same confidence as the right ones.
   */
  prospectiveHolders(
    workspaceId: string,
    fromPath: string,
    toPath: string,
  ): Promise<ProspectiveHolders>;

  /**
   * Finite expanded email set for configured users who could approve this path
   * — role members + direct user grants, minus anyone denied. The built-in
   * `everyone` role can grant arbitrary signed-in users and therefore cannot be
   * fully enumerated here. Returns a map from email to display info (display
   * name comes from direct user grants; role members have no name attached so
   * the entry is `{ name: '', email }`). Used by PR reviewer routing in
   * `createPr` to translate paths into a list of candidate GitHub logins.
   */
  eligibleWriterEmails(
    workspaceId: string,
    relativePath: string,
  ): Promise<Map<string, { name: string; email: string }>>;

  /**
   * Finite expanded email set for configured users who own this path — role
   * members + direct user grants, minus anyone denied. Mirrors
   * `eligibleWriterEmails` but for the `owner:` verb. Used by KB citation
   * revalidation to resolve who should refresh a section, expanding role-only
   * ownership into concrete emails so the future notifier has someone to
   * contact. As with `eligibleWriterEmails`, `everyone` is a valid `owner:`
   * value but grants arbitrary signed-in users and therefore cannot be fully
   * enumerated — this map may be incomplete when such a grant applies.
   */
  eligibleOwnerEmails(
    workspaceId: string,
    relativePath: string,
  ): Promise<Map<string, { name: string; email: string }>>;

  /**
   * Resolve WHERE a principal's effective access on a target comes from, per
   * verb. Powers the share dialog's inherited-vs-direct distinction and the
   * revoke route's "is this revoke a no-op because it's inherited?" decision.
   *
   * `kind` selects the target semantics: a `file` target's most-specific scope
   * is its own frontmatter; a `folder` target's is its own `access.md`. Both
   * read the same closeness-first resolver, so the returned source for each
   * verb reflects the SAME precedence every other access decision uses.
   *
   * Returns only the verbs the principal effectively holds; a verb with no
   * access is omitted. A principal with no access anywhere yields an empty map.
   *
   * `opts.tokenMatch: 'exact'` pins a ROLE-shaped principal to its literal
   * token spelling: only the exact token (bare, or `role/<name>`) counts as
   * the principal's own entry, regardless of group shadowing. The mutation
   * layer uses this so a check runs against the SAME identity a pinned
   * exact-token splice edited — e.g. verifying a GROUP deny whose group has
   * vanished, where the default (alias-tolerant when unshadowed) matching
   * would misattribute a same-named role's surviving `role/<name>` grant to
   * the group. Omitted (or `'name'`) → the shadowing-derived default.
   */
  grantSources(
    workspaceId: string,
    kind: AccessTargetKind,
    relativePath: string,
    principal: GrantPrincipal,
    opts?: { tokenMatch?: 'exact' | 'name' },
  ): Promise<GrantSources>;

  /**
   * The polarity twin of {@link grantSources}: per verb, WHERE the principal is
   * DENIED — a `deny` line in the target's own access file (`direct`) or in a
   * parent folder's (`ancestor`). Same closeness-first walk, same `tokenMatch`
   * pinning, same omit-what-does-not-apply shape.
   *
   * The share dialog needs this to say WHY a verb is off. "Restricted here" is a
   * fact about this target that only a denial entry carries; without it, a
   * principal restricted here is indistinguishable from one never granted, and
   * the dialog cannot offer to lift the restriction.
   *
   * Optional so existing test doubles stay valid; the real service implements it.
   */
  denialSources?(
    workspaceId: string,
    kind: AccessTargetKind,
    relativePath: string,
    principal: GrantPrincipal,
    opts?: { tokenMatch?: 'exact' | 'name' },
  ): Promise<DenialSources>;

  /**
   * Every principal DENIED some verb by the target's OWN access file — the
   * folder's `access.md`, or a file node's own frontmatter.
   *
   * The eligible lists cannot report these, by construction: a principal denied
   * every verb here holds nothing and appears in none of them, yet the
   * restriction IS an entry on this target and the row it belongs to has to stay
   * listed. Shaped like an eligible list so the view can union it in without a
   * second code path.
   *
   * Only the target's OWN scope counts. A denial inherited from a parent is
   * reported per-verb by {@link denialSources} against a row that already
   * exists; it does not, by itself, put a new row on this target.
   *
   * Optional so existing test doubles stay valid; the real service implements it.
   */
  locallyDeniedPrincipals?(
    workspaceId: string,
    kind: AccessTargetKind,
    relativePath: string,
  ): Promise<{ principals: ResolvedPrincipal[]; users: { name: string; email: string }[] }>;

  /**
   * The caller's own verdict on each verb at a target, and what decided it —
   * computed by the SAME walk `canRead` / `canWrite` / `canDownload` /
   * `canOwner` run (their booleans are its `allowed`), so an explanation never
   * disagrees with an operation. `kind` only decides which scope counts as the
   * target's own (`inherited: false`).
   *
   * Optional so existing test doubles stay valid; the real service implements it.
   */
  explainAccess?(
    workspaceId: string,
    userEmail: string,
    kind: AccessTargetKind,
    relativePath: string,
  ): Promise<Record<'read' | 'write' | 'download' | 'owner', AccessDecision>>;

  /**
   * Drop a workspace's cached model. Call after operations that mutate
   * `roles.yaml` / `access.md` (commit, push, pull) or change which copy of
   * those files the working tree sees (branch switch).
   */
  invalidate(workspaceId: string): void;

  /**
   * Validate a candidate `roles.yaml` text against the resolver's OWN loader,
   * WITHOUT writing it. The single safety gate behind the admin App roles
   * surface: `roles.yaml` has no admin-rescue and `loadModel` hard-throws on a
   * parse failure (which `isAdmin` swallows into `false` for everyone), so a
   * malformed write would be a permanent, app-wide, in-app-unrecoverable admin
   * lockout. The roles-admin service runs this on every candidate file before
   * the atomic commit; on any error it writes zero bytes. Because the gate IS the
   * resolver's loader, any text that passes is provably loadable.
   */
  validateRolesYaml(text: string): { ok: true } | { ok: false; errors: string[] };

  /**
   * Enumerate the grantable principals known to the KB, for the share-dialog
   * autocomplete. `roles` are the built-in `everyone` role plus the declared
   * `roles.yaml` role display names — ROLE principals only, never groups
   * (`everyone` is surfaced so the UI can grant public read; the grant route
   * gates it to the `read` verb only). `groups` are the ACTIVE group source's
   * display names as merged into the resolver's cached model — served from
   * that cache precisely so suggest/grant don't re-read the files per call.
   * `people` are every email named in `roles.yaml` (name defaults to the
   * local part) unioned with every `Name <email>` grant in any `access.md`
   * (named). The login-only `users` table is unioned in by the caller — this
   * method covers the KB-canonical people the users table misses.
   */
  kbPrincipals(workspaceId: string): Promise<{
    roles: string[];
    groups: string[];
    /**
     * Plugins whose `plugin/<Name>/<verb>` principals exist (personal folders
     * excluded): the display name and the repo-relative folder, so a caller
     * can apply the discoverability verdict (`canRead` on `<folder>/access.md`).
     */
    plugins: { name: string; folder: string }[];
    people: { name: string; email: string }[];
  }>;

  /**
   * Reverse-lookup an email by its SHA-256 hash (per `hashEmail` semantics)
   * against the working-tree access tree. Scans every email mentioned in
   * `roles.yaml` plus every direct user grant in any `access.md`.
   *
   * Used by PR author attribution as a fallback when the users-table lookup
   * misses — a teammate listed in `roles.yaml` may not yet have a row in
   * the `users` table (e.g. they haven't logged in since a DB reseed, but
   * their JWT is still valid). Returns null when no hash matches.
   */
  findEmailByHash(
    workspaceId: string,
    hash: string,
  ): Promise<{ email: string; displayName: string } | null>;

  /**
   * Resolve write permission for a path against the access tree **as it
   * exists on a specific git ref** (typically a PR head SHA). Used by PR
   * per-file approval so the gate reflects the access rules that would be
   * in force post-merge, not the reviewer's working tree.
   *
   * Returns null when the ref doesn't resolve or required config files
   * (`roles.yaml`) are absent at that ref — the caller treats null as
   * "can't determine eligibility, fall through to deny".
   */
  canWriteAtRef(
    workspaceId: string,
    ref: string,
    userEmail: string,
    relativePath: string,
  ): Promise<boolean | null>;

  /**
   * Resolve read permission for a path against the access tree **as it exists
   * on a specific git ref**. Mirror of `canWriteAtRef` for parity — read gates
   * that need post-merge semantics (rather than the reviewer's working tree)
   * use this. Returns null with the same semantics as `canWriteAtRef` (ref
   * unresolvable / required config absent → caller treats null as deny).
   */
  canReadAtRef(
    workspaceId: string,
    ref: string,
    userEmail: string,
    relativePath: string,
  ): Promise<boolean | null>;

  /**
   * Batched variant of `canWriteAtRef`. Loads the access tree at `ref` once
   * and checks every path against it. Returns null with the same semantics
   * as `canWriteAtRef` — the whole call returns null if the ref can't be
   * resolved. Used by `/pr/mine` so we don't fan out one `git ls-tree` per
   * PR.
   */
  canWriteBatchAtRef(
    workspaceId: string,
    ref: string,
    userEmail: string,
    relativePaths: string[],
  ): Promise<Map<string, boolean> | null>;

  /**
   * The set of principals with `write` on this path as of `ref`. Used by PR
   * reviewer routing and the per-file approval UI rendered against the PR
   * head. Returns null with the same null-semantics as `canWriteAtRef`.
   */
  eligibleWritersAtRef(
    workspaceId: string,
    ref: string,
    relativePath: string,
  ): Promise<{ roles: string[]; users: { name: string; email: string }[] } | null>;

  /**
   * Whether `userEmail` holds the Admin write floor at the repository root —
   * a member of the Admin role or the deployment owner — in the working-tree
   * model. The share dialog asks before restricting a PERSON's write at the
   * root: the floor keeps it, so the deny could only be rolled back.
   */
  holdsAdminRootWrite(workspaceId: string, userEmail: string): Promise<boolean>;

  /**
   * Whether `userEmail` may put a misplaced platform file back at
   * `destinationRelativePath` — the ONE write that is allowed to land on a
   * destination whose own rules would refuse it.
   *
   * A repository whose `access.md` or `roles.yaml` was moved out of the root
   * is one nobody can repair through the app: the root then resolves to
   * default-deny and the move that would fix it is the move the gate refuses.
   * So an admin (the `Admin` role or the deployment owner) may move a file
   * named `roles.yaml`, `.bevelignore` or the agent guide into the repository
   * root, and a file named `access.md` into a folder that has none.
   *
   * Only where the file is MISSING: a destination that already holds it is
   * false, because a move is a rename on disk and landing on the file would
   * replace the very rules the exception exists to bring back.
   *
   * Narrow on purpose, and the narrowness lives here rather than in the
   * caller: false for any other path, for any other destination, for a
   * destination spelled with `..`, and for anyone who is not an admin. It
   * grants no write anywhere else, and it is asked only about where a move
   * LANDS — never about what a move takes away, which is why a caller that
   * could take one away (the move route, the lock gate) also checks the
   * SOURCE with `isPlatformRestoreShape`.
   */
  canRestorePlatformFile(
    workspaceId: string,
    userEmail: string,
    destinationRelativePath: string,
  ): Promise<boolean>;

  /**
   * Batched: resolve eligible writers + expanded emails for a list of paths
   * at a specific ref in one model load. Returns null with the same
   * semantics as `eligibleWritersAtRef` (ref unresolvable).
   *
   * Used by PR per-file approval (`getApprovalStates`) so a 10-file PR
   * costs one `git ls-tree` round-trip instead of ten.
   */
  eligibleWritersForPathsAtRef(
    workspaceId: string,
    ref: string,
    relativePaths: string[],
  ): Promise<Map<
    string,
    {
      roles: string[];
      users: { name: string; email: string }[];
      /** Expanded email set — role members + direct user grants minus denials. */
      emails: Set<string>;
      /**
       * Named individuals (roles.yaml members + inline emails) who do NOT hold
       * write here. Used to subtract from a blanket `everyone` grant: it
       * catches exclusions at any tier — `deny email`, `deny role`, or a
       * `deny everyone` carve-out — not just direct user denials.
       */
      excludedEmails?: Set<string>;
    }
  > | null>;
}
