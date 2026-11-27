import {
  PLUGIN_MANIFEST_FILE,
  linkedSkillEntries,
  skillUnderRoot,
  type DroppedSkillEntry,
} from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import type { KbContext } from '../../shared/kb-context.js';
import type { ISkillService } from '../skills/index.js';
import type { ISkillLinkCheck, PluginSkillLinks, SkillLinkWarning } from './plugins.contract.js';

const log = logger('plugins');

/** What is wrong with each entry of one plugin's skill list, for one reader. */
interface SkillLinkFaults {
  /** Entries that are no folder path, in the file's order. */
  dropped: readonly DroppedSkillEntry[];
  /** Roots that start with the knowledge base's own folder name and hold nothing. */
  prefixed: readonly string[];
  /** Roots under which no skill the reader can read sits. */
  empty: readonly string[];
}

/**
 * The sentences that say which entries of a skill list link nothing: one per
 * kind of fault, each starting with its entries in the file's order and
 * saying what to do once. The plugin page and the save answer say the same
 * sentences, for a plugin.json and a bundle alike.
 */
export function skillLinkWarnings(
  faults: SkillLinkFaults,
  kb: { skillsDir: string; kbDirName: string },
): SkillLinkWarning[] {
  const out: SkillLinkWarning[] = [];
  const say = (names: string[], one: string, many: string) => {
    const list = joined(names);
    out.push({ entry: names.join(', '), message: capitalised(`${list} ${names.length === 1 ? one : many}`) });
  };
  if (faults.dropped.length > 0) {
    say(
      [...faults.dropped].sort((a, b) => a.position - b.position).map(named),
      `is not a folder path, so it is ignored. Write it like "${kb.skillsDir}/Engineering/deploy".`,
      `are not folder paths, so they are ignored. Write them like "${kb.skillsDir}/Engineering/deploy".`,
    );
  }
  const prefix = `${kb.kbDirName}/`;
  if (faults.prefixed.length > 0) {
    say(
      faults.prefixed.map((root) => JSON.stringify(root)),
      `starts with "${prefix}", so it links nothing. Remove "${prefix}".`,
      `start with "${prefix}", so they link nothing. Remove "${prefix}".`,
    );
  }
  if (faults.empty.length > 0) {
    say(
      faults.empty.map((root) => JSON.stringify(root)),
      'has no skill in it that you can open.',
      'have no skill in them that you can open.',
    );
  }
  return out;
}

/**
 * Which `skills` entries of a plugin.json link nothing, said to ONE reader
 * (see `ISkillLinkCheck`): the save answer (`checkSave`) and the plugin
 * listing (`linkWarnings`) both ask it, so the two say the same sentences.
 *
 * A root is reported when no skill the READER can read on the default branch
 * sits under it. That is the released catalog `POST /plugins/:name/links`
 * resolves a root against, narrowed to the reader, because an answer about
 * skills they cannot read would tell them where such skills are. So a root
 * holding only such skills is reported to them as holding none they can open.
 *
 * An EMPTY catalog proves no absence: it is also what the skill service
 * answers when the default branch cannot be read. Then no root is reported,
 * only the entries that are no folder path; the price is that a reader who
 * can read no skill at all is not told about roots either.
 */
export class SkillLinkCheck implements ISkillLinkCheck {
  constructor(
    private readonly skills: Pick<ISkillService, 'listSkills'>,
    private readonly kb: Pick<KbContext, 'kbDirName' | 'layout'>,
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
    const [warnings = []] = await this.linkWarnings(userEmail, [{ roots, dropped }]);
    return warnings;
  }

  async linkWarnings(userEmail: string, plugins: readonly PluginSkillLinks[]): Promise<SkillLinkWarning[][]> {
    const readable = await this.readableSkills(userEmail, plugins);
    const prefix = `${this.kb.kbDirName}/`;
    return plugins.map(({ roots, dropped }) => {
      // `null`: the catalog proves nothing, so no root is judged.
      const holdingNothing = readable === null ? [] : roots.filter((root) => !readable.some((p) => skillUnderRoot(p, root)));
      return skillLinkWarnings(
        {
          dropped,
          prefixed: holdingNothing.filter((root) => root.startsWith(prefix)),
          empty: holdingNothing.filter((root) => !root.startsWith(prefix)),
        },
        { skillsDir: this.kb.layout.skillsDir, kbDirName: this.kb.kbDirName },
      );
    });
  }

  /**
   * The paths of the skills `userEmail` can read, read once for every plugin;
   * `null` when no root needs judging, or when the catalog is empty or
   * cannot be read.
   */
  private async readableSkills(userEmail: string, plugins: readonly PluginSkillLinks[]): Promise<string[] | null> {
    if (plugins.every((p) => p.roots.length === 0)) return null;
    try {
      const paths = (await this.skills.listSkills(userEmail)).map((s) => s.path);
      return paths.length > 0 ? paths : null;
    } catch (err) {
      log.warn('linked-root check skipped', { err });
      return null;
    }
  }

  /** A `plugin.json` under the plugins root, in the workspace spelling the save surfaces receive. */
  private isPluginManifest(workspacePath: string): boolean {
    const parts = workspacePath.split('/').filter((p) => p && p !== '.');
    if (parts[0] === this.kb.kbDirName) parts.shift();
    return parts.length >= 3 && parts[0] === this.kb.layout.pluginsDir && parts[parts.length - 1] === PLUGIN_MANIFEST_FILE;
  }
}

/** An entry as the reader can find it in the file: a string as written, anything else by its place. */
function named({ position, entry }: DroppedSkillEntry): string {
  if (typeof entry === 'string') return JSON.stringify(entry);
  const what =
    entry === null
      ? 'empty'
      : Array.isArray(entry)
        ? 'a list'
        : typeof entry === 'object'
          ? 'an object'
          : typeof entry === 'number'
            ? `the number ${String(entry)}`
            : `the value ${String(entry)}`;
  return `entry ${position} (${what})`;
}

/** `a`, `a and b`, `a, b and c`. */
function joined(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function capitalised(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
