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

/** What the plugin page says about a linked root that holds no skill on the default branch. */
export function emptyLinkedRootWarning(root: string): string {
  return `linked folder ${JSON.stringify(root)} holds no skill, so it links nothing`;
}

/** One `skills` entry of a saved plugin.json that links nothing, and why. */
export interface SkillLinkWarning {
  /** The entry as the manifest holds it; a root by its normalised spelling. */
  entry: string;
  message: string;
}

/**
 * The save-time check for a plugin's `plugin.json`: one warning per `skills`
 * entry that `linkedSkillEntries` drops, and one per root under which no
 * skill the SAVER can read on the default branch sits. That is the released
 * catalog `POST /plugins/:name/links` resolves a root against, narrowed to
 * the saver: the saver chooses the paths, and an answer about skills they
 * cannot read would tell them where such skills are. So a root holding only
 * such skills is reported to them too, where the plugin page, which counts
 * from the unfiltered catalog, says nothing about it.
 *
 * An EMPTY catalog proves no absence: it is also what the skill service
 * answers when the default branch cannot be read. Then no root is reported,
 * only the dropped entries; the price is that a saver who can read no skill
 * at all is not told about roots either.
 *
 * Advisory: the route asks it after the write, and it never throws.
 */
export class PluginManifestSaveCheck {
  constructor(
    private readonly skills: Pick<ISkillService, 'listSkills'>,
    private readonly kb: Pick<KbContext, 'kbDirName' | 'layout' | 'defaultBranch'>,
  ) {}

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
    if (roots.length === 0) return warnings;
    try {
      const readable = await this.skills.listSkills(userEmail);
      if (readable.length === 0) return warnings;
      for (const root of roots) {
        if (readable.some((s) => skillUnderRoot(s.path, root))) continue;
        warnings.push({
          entry: root,
          message: `linked folder ${JSON.stringify(root)} holds no skill you can read on ${this.kb.defaultBranch}`,
        });
      }
    } catch (err) {
      log.warn('plugin.json link check skipped', { err });
    }
    return warnings;
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
