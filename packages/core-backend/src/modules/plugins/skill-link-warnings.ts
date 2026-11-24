import { PLUGIN_MANIFEST_FILE, linkedSkillEntries, skillUnderRoot } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import type { KbContext } from '../../shared/kb-context.js';
import type { ISkillService } from '../skills/index.js';

const log = logger('plugins');

/**
 * What is said about a plugin.json `skills` entry that `linkedSkillEntries`
 * drops: the plugin page (through discovery) and the save answer say the
 * same sentence. A non-string entry is named by its type, never serialised.
 */
export function droppedSkillEntryWarning(entry: unknown, skillsDir: string): string {
  return `skills entry ${spelled(entry)} is ignored: use a folder path like "${skillsDir}/Engineering/deploy"`;
}

/** One `skills` entry of a plugin.json that links nothing for its reader, and why. */
export interface SkillLinkWarning {
  /** The entry as the manifest holds it; a root by its normalised spelling. */
  entry: string;
  message: string;
}

/**
 * Which `skills` entries of a plugin.json link nothing, said to ONE reader:
 * the save answer (`checkSave`) and the plugin listing (`emptyRootWarnings`)
 * both ask it, so the two say the same thing about the same roots.
 *
 * A root is reported when no skill the READER can read on the default branch
 * sits under it. That is the released catalog `POST /plugins/:name/links`
 * resolves a root against, narrowed to the reader, because an answer about
 * skills they cannot read would tell them where such skills are. So a root
 * holding only such skills is reported to them as holding none they can read.
 *
 * An EMPTY catalog proves no absence: it is also what the skill service
 * answers when the default branch cannot be read. Then no root is reported;
 * the price is that a reader who can read no skill at all is not told about
 * roots either. Advisory throughout, and it never throws.
 */
export class SkillLinkCheck {
  constructor(
    private readonly skills: Pick<ISkillService, 'listSkills'>,
    private readonly kb: Pick<KbContext, 'kbDirName' | 'layout' | 'defaultBranch'>,
  ) {}

  /**
   * The saved file's warnings: `[]` unless it is a plugin.json under the
   * plugins root; else one per dropped entry and one per root that holds no
   * skill the saver can read. The route asks it after the write.
   */
  async checkSave(userEmail: string, workspacePath: string, content: string): Promise<SkillLinkWarning[]> {
    if (!this.isPluginManifest(workspacePath)) return [];
    let manifest: unknown;
    try {
      manifest = JSON.parse(content);
    } catch {
      return []; // the plugin page says the manifest is not a JSON object
    }
    const { roots, dropped } = linkedSkillEntries(manifest);
    const warnings: SkillLinkWarning[] = dropped.map((entry) => ({
      entry: typeof entry === 'string' ? entry : spelled(entry),
      message: droppedSkillEntryWarning(entry, this.kb.layout.skillsDir),
    }));
    const [empty = []] = await this.emptyRootWarnings(userEmail, [roots]);
    return [...warnings, ...empty];
  }

  /**
   * For each list of roots, one warning per root under which no skill
   * `userEmail` can read on the default branch sits: one catalog read for
   * every list. Each list answers `[]` when that catalog is empty or cannot
   * be read.
   */
  async emptyRootWarnings(
    userEmail: string,
    rootLists: readonly (readonly string[])[],
  ): Promise<SkillLinkWarning[][]> {
    const none = rootLists.map(() => []);
    if (rootLists.every((roots) => roots.length === 0)) return none;
    let readable: string[];
    try {
      readable = (await this.skills.listSkills(userEmail)).map((s) => s.path);
    } catch (err) {
      log.warn('linked-root check skipped', { err });
      return none;
    }
    if (readable.length === 0) return none;
    return rootLists.map((roots) =>
      roots
        .filter((root) => !readable.some((p) => skillUnderRoot(p, root)))
        .map((root) => ({
          entry: root,
          message: `linked folder ${JSON.stringify(root)} holds no skill you can read on ${this.kb.defaultBranch}`,
        })),
    );
  }

  /** A `plugin.json` under the plugins root, in the workspace spelling the save surfaces receive. */
  private isPluginManifest(workspacePath: string): boolean {
    const parts = workspacePath.split('/').filter((p) => p && p !== '.');
    if (parts[0] === this.kb.kbDirName) parts.shift();
    return parts.length >= 3 && parts[0] === this.kb.layout.pluginsDir && parts[parts.length - 1] === PLUGIN_MANIFEST_FILE;
  }
}

function spelled(entry: unknown): string {
  if (typeof entry === 'string') return JSON.stringify(entry);
  return `(a value of type ${entry === null ? 'null' : Array.isArray(entry) ? 'array' : typeof entry})`;
}
