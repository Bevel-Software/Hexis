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
export type ResolvedPrincipal = { name: string; kind: 'role' | 'group' };

/**
 * Per-verb sources of a principal's access on a target. Only verbs the principal
 * actually holds (via a named file entry) appear; each maps to the closest-first
 * list of scopes that grant it (see `VerbSources`). A principal with no named
 * grant at all yields an empty map.
 */
export type GrantSources = Partial<Record<'read' | 'write' | 'download' | 'owner', VerbSources>>;

export interface IAccessControl {
  /** True iff `userEmail` has `write` on `relativePath` per the current access tree. */
  canWrite(workspaceId: string, userEmail: string, relativePath: string): Promise<boolean>;

  /**
   * True iff `userEmail` may READ `relativePath` per the current access tree.
   *
   * `read` is **default-deny**: a path with no effective `read:`, `write:`, or
   * `owner:` grant is not readable. To make content public, declare the
   * built-in role `everyone` under `read:`. Resolution is closeness-first then
   * tier (email > role > everyone within a scope), folding `write:`/`owner:` in
   * as implicit read grants (grant-only — a write/owner denial never strips a
   * read grant). No admin rescue. The file viewer, embed surface, and the
   * agent's read tools all gate on this.
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
   * (owner is a superset of write + download).
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
   * denial — the node is readable by all signed-in users, and the role/user
   * lists are empty because their content would be meaningless. When
   * `restricted` is true the lists name the principals (roles + direct users)
   * that may read, with owners folded in (an `owner:` grant confers read). The
   * lists may be empty for a default-denied path with no grants.
   */
  eligibleReaders(
    workspaceId: string,
    relativePath: string,
  ): Promise<{
    restricted: boolean;
    principals?: ResolvedPrincipal[];
    roles: string[];
    users: { name: string; email: string }[];
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
   * Drop a workspace's cached model. Call after operations that mutate
   * `roles.yaml` / `access.md` (commit, push, pull) or change which copy of
   * those files the working tree sees (branch switch).
   */
  invalidate(workspaceId: string): void;

  /**
   * Validate a candidate `roles.yaml` text against the resolver's OWN loader,
   * WITHOUT writing it. The single safety gate behind the admin Roles & Members
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
  kbPrincipals(
    workspaceId: string,
  ): Promise<{ roles: string[]; groups: string[]; people: { name: string; email: string }[] }>;

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
