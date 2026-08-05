/**
 * Skills are reusable specialist instructions living under `Groups/<group>/<name>/SKILL.md`
 * in the KB repo. Discovery/loading is pinned to the DEFAULT branch — the catalog
 * is a single global, released set (a skill on a draft isn't discoverable until
 * merged). Progressive disclosure: `listSkills` = name + description (level 1),
 * `getSkill` = full body + bundled-file paths (level 2), `getSkill(file)` = a
 * bundled file's content (level 3).
 */

export interface SkillSummary {
  /** Canonical id = the skill's folder name (e.g. `rfi`). */
  name: string;
  description: string;
  version?: string;
  /** Repo-root-relative skill folder, e.g. `Groups/Everyone/rfi`. */
  path: string;
}

export interface Skill extends SkillSummary {
  /** The SKILL.md markdown body (instructions to follow). */
  body: string;
  /** Pre-approved tools from the `allowed-tools` frontmatter, if declared. */
  allowedTools?: string[];
  /** Repo-root-relative bundled file paths, e.g. `Groups/Everyone/rfi/scripts/build_xlsx.py`. */
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
