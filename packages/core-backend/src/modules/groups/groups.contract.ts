/**
 * Groups — the folders under `Groups/` that carry a team's skills and the
 * tools those skills need. A group is a FOLDER, never a role: one access
 * boundary, one place, derived from the path exactly the way `groupOfPath`
 * derives it.
 *
 * Enumeration follows the KB's read model with NO special cases: a group
 * appears for a caller exactly when the access resolution says something
 * about it —
 *
 *   - MEMBER: the caller can read the folder itself (`canRead`).
 *   - MANAGER: the caller can write the folder's `access.md` (`canWrite`,
 *     admin-rescued).
 *   - DISCOVERABLE: the caller can read the `access.md` FILE — which, in the
 *     new body-governed format, is granted by the file's own
 *     `read: everyone` frontmatter (see `accessMdSelfEntries`). The group
 *     shows locked, and the caller may ask to join.
 *
 * A group where all three verdicts are false is ABSENT from the response —
 * name, counts and principals never leave the backend. Making a group secret
 * is therefore an ordinary access edit: drop the `everyone` grant from its
 * access.md frontmatter.
 *
 * Requesting access is a CHANGE REQUEST, not a bespoke system: the join
 * route commits "add me to the body's `read:` list" on a draft branch and
 * opens a CR that the folder's writers approve by merging (or by granting
 * via Manage access, which makes the CR moot). To agents these are plain
 * change requests; only the UI dresses them up.
 */

/** Access-rule principals as the resolver hands them back. */
export interface ResolvedPrincipals {
  roles: string[];
  users: { name: string; email: string }[];
}

export interface ResolvedReaders extends ResolvedPrincipals {
  restricted: boolean;
}

/** One group as `GET /api/groups` reports it, resolved for ONE caller. */
export interface GroupSummary {
  /** Group folder name, e.g. `GTM`. */
  name: string;
  /** Repo-relative constituent folders, e.g. `['Groups/GTM']`. */
  folders: string[];
  /**
   * Per-caller: the caller can read the FOLDER (membership). Every returned
   * group has at least one of `canRead` / `canWrite` / discoverability; a
   * group with none is not returned at all.
   */
  canRead: boolean;
  /**
   * Per-caller; true ⇒ may manage access. Resolved as write on the folder's
   * `access.md`, which admin-rescues — so a platform Admin locked OUT of
   * reading still sees the group and gets the self-service way back in.
   */
  canWrite: boolean;
  /** Caller-INDEPENDENT total (the group's whole content, not the caller's slice). */
  skillCount: number;
  toolCount: number;
  /** For display: "Run by …" (fallback chain: owners → writers → 'the workspace admins'). */
  owners: ResolvedPrincipals;
  writers: ResolvedPrincipals;
  readers: ResolvedReaders;
  /**
   * The caller has an OPEN join change request for this group (their
   * deterministic join branch has an open CR). Always false for a member.
   */
  hasRequested: boolean;
  /** The open join CR's number when `hasRequested` (deep-links the UI). */
  requestNumber: number | null;
}

/**
 * The caller-INDEPENDENT slice of a group — what `catalog()` computes once and
 * caches. The per-caller verdicts (`canRead`/`canWrite`, and whether the group
 * appears at all) are resolved per request in the route.
 */
export interface GroupCatalogEntry {
  name: string;
  folders: string[];
  skillCount: number;
  toolCount: number;
  owners: ResolvedPrincipals;
  writers: ResolvedPrincipals;
  readers: ResolvedReaders;
}

export interface IGroupIndexService {
  /** Caller-independent catalog part (folders, counts, principals) — cached 60s. */
  catalog(): Promise<GroupCatalogEntry[]>;
  /** Drop the cached catalog (call after a default-branch change under a group root). */
  invalidate(): void;
}
