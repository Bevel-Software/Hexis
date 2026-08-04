/**
 * Groups — the folders under `Groups/` that carry a team's skills and the
 * tools those skills need. A group is a FOLDER, never a role: one access
 * boundary, one place, derived from the path exactly the way `groupOfPath`
 * derives it.
 *
 * `GET /api/groups` is the one enumeration surface, and it follows the KB's
 * read model to the letter: a group the caller cannot access is simply ABSENT
 * from the response — same fail-closed posture as the file tree, the skill
 * catalog and the tool listing. There is no locked-group discovery and no
 * access-request machinery; joining a group is an `access.md` grant made
 * through the normal access-management flow.
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
   * Per-caller. Every returned group has `canRead` or `canWrite`; a group
   * with neither is not returned at all.
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
