/**
 * Skills are reusable specialist instructions living under `Plugins/<plugin>/<name>/SKILL.md`
 * in the KB repo. Discovery/loading is pinned to the DEFAULT branch — the catalog
 * is a single global, released set (a skill on a draft isn't discoverable until
 * merged). Progressive disclosure: `listSkills` = name + description (level 1),
 * `getSkill` = full body + bundled-file paths (level 2), `getSkill(file)` = a
 * bundled file's content (level 3).
 */

/**
 * One plugin a skill belongs to — by sitting INSIDE the plugin folder
 * (`linked: false`) or by being LINKED from the plugin's manifest
 * (`linked: true`). For a link, `granted` says whether the skill's own access
 * rules name the plugin's `plugin/<Name>/read` principal, which is what makes
 * the link work for the plugin's members; the link service writes that grant
 * with the link, so `false` means a hand edit took it away.
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
  /** The governance owner from `metadata.owner`, when the skill declares one. */
  owner?: string;
  /**
   * The governance lifecycle from `metadata.lifecycle`, lowercased — `active`
   * (or absent), `deprecated` (still served, flagged), `retired` (served to the
   * catalog for its owners, never compiled into a distribution).
   */
  lifecycle?: string;
  /** Repo-root-relative skill folder, e.g. `Plugins/Everyone/rfi`. */
  path: string;
  /**
   * The plugins this skill belongs to, decorated onto the catalog by the
   * browser route (the catalog itself is plugin-unaware). Absent on the agent
   * surfaces, which load skills by name and never by plugin.
   */
  plugins?: PluginMembership[];
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
}

export type GetSkillResult =
  | { ok: true; kind: 'skill'; skill: Skill }
  | { ok: true; kind: 'file'; file: SkillFileContent }
  | { ok: false; error: 'not_found' | 'forbidden' | 'invalid_file' };

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
   * The default-branch skill catalog. When `userEmail` is given, filtered to
   * skills that user may read (`canRead`); omit it for the global set (used to
   * compose the tool descriptions in the manual).
   */
  listSkills(userEmail?: string): Promise<SkillSummary[]>;
  /** Load a skill's body (+ files), or a bundled file's content when `file` is given. */
  getSkill(userEmail: string, name: string, file?: string): Promise<GetSkillResult>;
  /** Drop the cached catalog (call after a merge to the default branch). */
  invalidate(): void;
}
