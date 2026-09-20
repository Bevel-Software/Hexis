/**
 * Plugins — the folders under `Plugins/` that carry a team's skills and the
 * tools those skills need. A plugin is a FOLDER, never a role: one access
 * boundary, one place, derived from the path exactly the way `pluginOfPath`
 * derives it.
 *
 * A plugin EXISTS exactly when its folder carries an `access.md` — the file
 * the provisioning endpoint seeds. A bare directory under `Plugins/` is not a
 * plugin (git cannot record an empty folder, so deleted plugins leave ghost
 * directories on live checkouts).
 *
 * Enumeration then follows the KB's read model with NO special cases: an
 * existing plugin appears for a caller exactly when the access resolution says
 * something about it —
 *
 *   - MEMBER: the caller can read the folder itself (`canRead`).
 *   - MANAGER: the caller can write the folder's `access.md` (`canWrite`,
 *     admin-rescued).
 *   - DISCOVERABLE: the caller can read the `access.md` FILE — which, in the
 *     new body-governed format, is granted by the file's own
 *     `read: everyone` frontmatter (see `accessMdSelfEntries`). The plugin
 *     shows locked, and the caller may ask to join.
 *
 * A plugin where all three verdicts are false is ABSENT from the response —
 * name, counts and principals never leave the backend. Making a plugin secret
 * is therefore an ordinary access edit: drop the `everyone` grant from its
 * access.md frontmatter.
 *
 * Requesting access is a CHANGE REQUEST, not a bespoke system: the join
 * route commits "add me to the body's `read:` list" on a draft branch and
 * opens a CR that the folder's writers approve by merging (or by granting
 * via Manage access, which makes the CR moot). To agents these are plain
 * change requests; only the UI dresses them up.
 */

export type { PluginMembership } from '../skills/skills.contract.js';

/** Access-rule principals as the resolver hands them back. */
export interface ResolvedPrincipals {
  roles: string[];
  users: { name: string; email: string }[];
}

export interface ResolvedReaders extends ResolvedPrincipals {
  restricted: boolean;
}

/** One plugin as `GET /api/plugins` reports it, resolved for ONE caller. */
export interface PluginSummary {
  /** The plugin's identity — its manifest name, e.g. `gtm`. */
  name: string;
  /** What a person sees it called, e.g. `GTM`. */
  displayName: string;
  /** Repo-relative constituent folders, e.g. `['Plugins/GTM']`. */
  folders: string[];
  /**
   * Repo-relative roots the plugin LINKS — its manifest's linked-skill roots
   * (`extensions["software.bevel.hexis"].skills`), or a bundle's
   * `sourceSkillRoots`.
   *
   * Served because a plugin's page has to say which of its cards live
   * somewhere else. A SKILL carries its own membership record (linked or
   * inline); a TOOL carries none — a `.tool` sitting beside the skills under
   * a linked root reaches the plugin exactly the way those skills do, and
   * these roots are the only thing that says so.
   */
  linkedRoots: string[];
  /** Whether this platform writes the plugin's links — see `PluginCatalogEntry`. */
  linksAreManaged: boolean;
  /**
   * Per-caller: the caller can read the FOLDER (membership). Every returned
   * plugin has at least one of `canRead` / `canWrite` / discoverability; a
   * plugin with none is not returned at all.
   */
  canRead: boolean;
  /**
   * Per-caller; true ⇒ may manage access. Resolved as write on the folder's
   * `access.md`, which admin-rescues — so a platform Admin locked OUT of
   * reading still sees the plugin and gets the self-service way back in.
   */
  canWrite: boolean;
  /**
   * Per-caller: the caller holds the `owner` verb on the FOLDER — resolved
   * from the `owner:` lists alone, no admin rescue. Deleting the plugin is the
   * owner's verb (the DELETE route enforces the same verdict); managers who
   * merely write the access.md do not get it.
   */
  isOwner: boolean;
  /** Caller-INDEPENDENT total (the plugin's whole content, not the caller's slice). */
  skillCount: number;
  toolCount: number;
  /**
   * Caller-INDEPENDENT: how many of the plugin's LINKED skills its members
   * cannot read — the link is in the manifest, but the skill folder no
   * longer grants the plugin's readers. Counted here, from the unfiltered
   * link index, because the people who most need the warning are the
   * plugin's managers, and they are exactly the people a missing grant
   * locks out: a count derived from what the caller can read would be zero
   * for them. Zero for a plugin whose links are not managed here.
   */
  brokenLinks: number;
  /** For display: "Run by …" (fallback chain: owners → writers → 'the workspace admins'). */
  owners: ResolvedPrincipals;
  writers: ResolvedPrincipals;
  readers: ResolvedReaders;
  /** The plugin's access.md says of itself that it is private — see `PluginCatalogEntry.isPrivate`. */
  isPrivate: boolean;
  /** What discovery left out of this plugin and why — see `PluginCatalogEntry.warnings`. */
  warnings: string[];
  /**
   * The caller has an OPEN join change request for this plugin (their
   * deterministic join branch has an open CR). Always false for a member.
   */
  hasRequested: boolean;
  /** The open join CR's number when `hasRequested` (deep-links the UI). */
  requestNumber: number | null;
}

/**
 * The caller-INDEPENDENT slice of a plugin — what `catalog()` computes once and
 * caches. The per-caller verdicts (`canRead`/`canWrite`, and whether the plugin
 * appears at all) are resolved per request in the route.
 */
export interface PluginCatalogEntry {
  /** The plugin's identity — its manifest name. */
  name: string;
  /** What a person sees it called — the manifest's `displayName`, else its `name`. */
  displayName: string;
  folders: string[];
  /** The roots it links skills from — see `PluginSummary.linkedRoots`. */
  linkedRoots: string[];
  /**
   * Whether this platform writes the plugin's links (a native `plugin.json`)
   * — false for a plugin read from an external format, whose links are
   * edited in that repository and which the link endpoints refuse.
   */
  linksAreManaged: boolean;
  skillCount: number;
  toolCount: number;
  /** Linked skills the members cannot read — see `PluginSummary.brokenLinks`. */
  brokenLinks: number;
  owners: ResolvedPrincipals;
  writers: ResolvedPrincipals;
  readers: ResolvedReaders;
  /**
   * The folder's access.md FRONTMATTER denies `everyone` read and names
   * nobody but people (`isPrivateAccessMd`) — the shape a personal space is
   * seeded with, and what a person writes to keep a plugin to a few named
   * colleagues. The Library marks such a plugin "Private". A statement the
   * file makes about itself, not a verdict: `readers` says who can use it.
   */
  isPrivate: boolean;
  /**
   * What discovery left out of THIS plugin and why, in plain words: an MCP
   * server its profile selects that the registry could not keep, a skill
   * root that is not a folder, a profile that does not exist. Attributed by
   * folder from the discovery warnings, with the folder prefix removed, so
   * the plugin's page can list them for the people who can fix the files —
   * the server log is not where a plugin's owner looks. Empty when nothing
   * was left out.
   */
  warnings: string[];
}

export interface IPluginIndexService {
  /** Caller-independent catalog part (folders, counts, principals) — cached 60s. */
  catalog(): Promise<PluginCatalogEntry[]>;
  /** Drop the cached catalog (call after a default-branch change under a plugin root). */
  invalidate(): void;
}
