/**
 * Groups — the folders under `Groups/` that carry a team's skills and the
 * tools those skills need. A group is a FOLDER, never a role: one access
 * boundary, one place, derived from the path exactly the way `groupOfPath`
 * derives it.
 *
 * `GET /api/groups` is the one enumeration surface. It is deliberately readable
 * by every authenticated user — a group the caller CANNOT read still appears,
 * carrying its name, its constituent folders, its totals and who runs it, so
 * the Library can show it as locked and offer a way in. What it never carries
 * for a non-reader is item names, the reader roster, or any email.
 */

/**
 * Access-rule principals as the resolver hands them back — emails always
 * present. This is the SERVER-side shape (`catalog()`); the wire type below
 * nulls the emails for callers who cannot read the group.
 */
export interface ResolvedPrincipals {
  roles: string[];
  users: { name: string; email: string }[];
}

export interface ResolvedReaders extends ResolvedPrincipals {
  restricted: boolean;
}

/** Wire-side principals: `email` is null on entries the caller cannot read. */
export interface GroupPrincipals {
  roles: string[];
  /** email is null on entries the caller cannot read (no email leakage to non-readers). */
  users: { name: string; email: string | null }[];
}

export interface GroupReaders extends GroupPrincipals {
  restricted: boolean;
}

/** One group as `GET /api/groups` reports it, resolved for ONE caller. */
export interface GroupSummary {
  /** Group folder name, e.g. `GTM`. */
  name: string;
  /** Repo-relative constituent folders, e.g. `['Groups/GTM']`. */
  folders: string[];
  /** Per-caller; locked === !canRead. */
  canRead: boolean;
  /**
   * Per-caller; true ⇒ may manage access. Resolved as write on the folder's
   * `access.md`, which admin-rescues — so a platform Admin locked OUT of
   * reading still gets `canWrite: true` and the self-service way back in.
   */
  canWrite: boolean;
  /** Caller-INDEPENDENT total (the group's whole content, not the caller's slice). */
  skillCount: number;
  toolCount: number;
  /** For display: "Run by …" (fallback chain: owners → writers → 'the workspace admins'). */
  owners: GroupPrincipals;
  writers: GroupPrincipals;
  /** null when `!canRead` — a locked group never advertises its share list. */
  readers: GroupReaders | null;
  /** The caller has a pending access request; always false when `canRead`. */
  hasRequested: boolean;
}

/**
 * The caller-INDEPENDENT slice of a group — what `catalog()` computes once and
 * caches. Everything per-caller (`canRead`/`canWrite`/`hasRequested`, the
 * withheld readers, the stripped emails) is resolved per request in the route.
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

/** One pending access request, as the admin-gated list surface reports it. */
export interface GroupAccessRequestEntry {
  id: string;
  group: string;
  requesterName: string;
  /** Admin-gated surface ONLY — never present on `GET /api/groups`. */
  requesterEmail: string;
  /** ISO timestamp. */
  createdAt: string;
}

export interface IGroupIndexService {
  /** Caller-independent catalog part (folders, counts, principals) — cached 60s. */
  catalog(): Promise<GroupCatalogEntry[]>;
  /** Drop the cached catalog (call after a default-branch change under a group root). */
  invalidate(): void;
}
