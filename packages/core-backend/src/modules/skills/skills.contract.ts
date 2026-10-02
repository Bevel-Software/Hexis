/**
 * Skills are reusable specialist instructions living under `Plugins/<plugin>/<name>/SKILL.md`
 * in the KB repo. Discovery/loading is pinned to the DEFAULT branch — the catalog
 * is a single global, released set (a skill on a draft isn't discoverable until
 * merged) — UNLESS the caller names a branch, which reads the skills as they are
 * on that draft and marks the ones the default branch does not have yet (see
 * {@link ListSkillsOptions} and `unmerged` below). Progressive disclosure:
 * `listSkills` = name + description (level 1),
 * `getSkill` = full body + bundled-file paths (level 2), `getSkill(file)` = a
 * bundled file's content (level 3).
 */

/**
 * One plugin a skill belongs to — by sitting INSIDE the plugin folder
 * (`linked: false`) or by being LINKED from the plugin's manifest
 * (`linked: true`). For a link, `granted` is the link's HEALTH: whether the
 * plugin's members can read the skill through it. For a link this platform
 * manages that is whether the skill's own access rules name the plugin's
 * `plugin/<Name>/read` principal — the link service writes that grant with
 * the link, so `false` means a hand edit took it away. A link read from an
 * external plugin format needs no grant (the skill's own scope decides who
 * reads it) and is always `true`; the flag never proves a principal exists.
 */
export interface PluginMembership {
  /** The plugin folder name. */
  name: string;
  linked: boolean;
  granted: boolean;
}

export interface SkillSummary {
  /** Canonical id = the skill's folder name (e.g. `rfi`). */
  name: string;
  description: string;
  version?: string;
  /** Repo-root-relative skill folder, e.g. `Plugins/Everyone/rfi`. */
  path: string;
  /**
   * The plugins this skill belongs to, decorated onto the catalog by the
   * browser route (the catalog itself is plugin-unaware). Absent on the agent
   * surfaces, which load skills by name and never by plugin.
   */
  plugins?: PluginMembership[];
  /**
   * Set only on an answer read from a branch OTHER than the default, and only
   * on a skill whose folder DIFFERS there: it exists only on that branch, or
   * its content was changed on it. Nobody has approved what such a skill says
   * — it is not merged. A skill the branch shares byte-for-byte with the
   * default branch carries no mark, because there is nothing unapproved about
   * it.
   */
  unmerged?: true;
  /** With `unmerged`: the branch the skill was read from. */
  branch?: string;
}

export interface Skill extends SkillSummary {
  /** The SKILL.md markdown body (instructions to follow). */
  body: string;
  /** Pre-approved tools from the `allowed-tools` frontmatter, if declared. */
  allowedTools?: string[];
  /** Repo-root-relative bundled file paths, e.g. `Plugins/Everyone/rfi/scripts/build_xlsx.py`. */
  files: string[];
}

export interface SkillFileContent {
  /** The skill name. */
  name: string;
  /** The bundled file, relative to the skill folder (e.g. `scripts/build_xlsx.py`). */
  file: string;
  /** Repo-root-relative path of the file. */
  path: string;
  content: string;
  /**
   * As on {@link SkillSummary} — the file came off a branch whose copy of this
   * skill differs from the default branch's. A note BESIDE the content, never
   * inside it: a bundled file is a script or a data file, and a sentence
   * prepended to one is a syntax error rather than a warning. A skill's body,
   * which is prose an agent reads, carries the line instead.
   */
  unmerged?: true;
  branch?: string;
}

export type GetSkillResult =
  | { ok: true; kind: 'skill'; skill: Skill }
  | { ok: true; kind: 'file'; file: SkillFileContent }
  | { ok: false; error: 'not_found' | 'forbidden' | 'invalid_file' }
  /**
   * A `version` was asked for that no commit of the skill's `SKILL.md`
   * declared in the history searched — the default branch's, or `branch`'s own
   * when a branch was named. `versions` is every version that history did
   * declare, newest first, so it too is that branch's answer: the caller picks
   * from those or asks for the latest by leaving `version` out.
   */
  | { ok: false; error: 'version_not_found'; versions: string[] };

/**
 * What `listSkills` may be asked beyond a caller.
 *
 * The branch is the ONE thing that moves the catalog off the default branch.
 * Omitted (or naming the default branch itself), every answer is exactly the
 * released one — the browser menu and the MCP prompts take that path and are
 * unaffected by this option existing.
 */
export interface ListSkillsOptions {
  /**
   * Read the skills as they are on this branch instead of the default one: a
   * skill that exists only there is listed, one changed there is listed with
   * its changed description and version, one deleted there is absent. Access
   * is judged on THAT branch, with that branch's access rules. A branch the
   * platform has never heard of is a 404 naming it, as on the file tools.
   *
   * Everything listed from a non-default branch that differs from the default
   * carries `unmerged: true` and this branch name: nobody approved it.
   */
  branch?: string;
}

/** What `getSkill` may be asked beyond a name and a file. */
export interface GetSkillOptions {
  /**
   * The version the skill declared in the copy to load — its
   * `metadata.version`, else a top-level `version`, else `lifecycle.version`.
   * Omitted, the skill is loaded as it is now — the latest. Given, the
   * history of the skill's `SKILL.md` is searched newest first for the most
   * recent commit that declared exactly this version, and the skill (body,
   * bundled files, or the one `file` asked for) is served as it was at that
   * commit. Read access is the caller's access to the skill as it is now: a
   * skill you may read, you may read the history of.
   *
   * The history searched is the one belonging to the branch being read: the
   * default branch's, or — with `branch` — that branch's own, including the
   * `versions` a `version_not_found` lists.
   */
  version?: string;
  /**
   * Load the skill as it is on this branch instead of the default one — see
   * {@link ListSkillsOptions.branch}, which it mirrors exactly: same branch
   * resolution, same 404, same access rules read on that branch. When the
   * skill differs from the default branch's copy, the body returned BEGINS
   * with one line saying so (a bundled file carries `unmerged` beside its
   * content instead).
   *
   * With `version`, the history searched is that branch's own. The agent
   * tools refuse the two together rather than make a caller reason about which
   * branch a version came from; this service answers both, because the
   * combination has exactly one sensible meaning.
   */
  branch?: string;
}

/**
 * The slice of git the skill service reads history through. Every call names
 * the workspace to read in, which is always the clone the skill itself was
 * scanned out of — the default branch's, or the draft a `branch` named, so a
 * version asked for on a branch is answered from that branch's history.
 * Narrow on purpose: the catalog is a disk scan and needs none of this; only
 * a `version` asks for history.
 */
export interface SkillHistorySource {
  /** The commits (newest first) on `ref` that touched `repoRelativePath`, at most `limit`. */
  pathHistory(workspaceId: string, ref: string, repoRelativePath: string, limit: number): Promise<string[]>;
  /** The file's content at `ref`, or null when it is not there at that ref. */
  readFileAtRef(workspaceId: string, ref: string, repoRelativePath: string): Promise<string | null>;
  /** Every file under `folder` at `ref`, repo-root-relative. */
  listFilesAtRef(workspaceId: string, ref: string, folder: string): Promise<string[]>;
}

/**
 * A skill that exists ONLY on an open change request's branch — proposed, not
 * released. It is deliberately NOT a `SkillSummary` the catalog returns: the
 * catalog is what agents load, and a skill nobody has approved must not be
 * loadable. This is a review surface only.
 *
 * Who may see one is narrower than who may see the catalog: its author, and
 * whoever could approve it. See `PendingSkillsService` for why that predicate
 * is the access tree's answer rather than a plugin-admin check spelled out
 * again here.
 */
export interface PendingSkill extends SkillSummary {
  /** The open change request that would release it. */
  changeRequestNumber: number;
  branch: string;
  /** Display name of whoever opened the request (person or agent). */
  authorName: string;
  createdAt: string;
  /** True when the caller opened the request themselves. */
  isAuthor: boolean;
}

export interface IPendingSkillService {
  /**
   * Skills awaiting approval that `userEmail` is entitled to see — the ones
   * they proposed, and the ones they could approve. Never throws: a review
   * surface failing must not take the library down with it.
   */
  listPendingSkills(userEmail: string): Promise<PendingSkill[]>;
}

export interface ISkillService {
  /**
   * The default-branch skill catalog — or `options.branch`'s, when one is
   * named. When `userEmail` is given, filtered to skills that user may read
   * (`canRead`, judged on the branch being read); omit it for the global set
   * (used to compose the tool descriptions in the manual, which always
   * describe the default branch).
   */
  listSkills(userEmail?: string, options?: ListSkillsOptions): Promise<SkillSummary[]>;
  /**
   * Load a skill's body (+ files), or a bundled file's content when `file` is
   * given — as it is now, or as it was at the commit that declared
   * `options.version` (see {@link GetSkillOptions}).
   */
  getSkill(userEmail: string, name: string, file?: string, options?: GetSkillOptions): Promise<GetSkillResult>;
  /**
   * Drop the cached DEFAULT-branch catalog (call after a merge to it). A
   * branch read is never cached, so an agent that writes a skill on its draft
   * and lists it right after sees what it just wrote.
   */
  invalidate(): void;
}
