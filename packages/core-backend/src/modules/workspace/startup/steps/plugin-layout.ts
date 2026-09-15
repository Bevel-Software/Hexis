import {
  HEXIS_EXTENSION_NS,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  PLUGIN_SKILLS_DIR,
} from '@bevel-software/platform-shared';
import { BUNDLE_FILE } from '../../../plugins/discovery/bundle-dialect/bundle.source.js';
import { isSkippedEntry, type ITreeWalker, type WalkedEntry } from '../../../../shared/fs.contract.js';

/**
 * Whether a folder's listing carries a plugin manifest or a bundle as a
 * regular file — THE "has a manifest" judgement, shared by the manifest step
 * and the migration. Pure: it reads the entries it is given and touches no
 * disk, so it stays a function.
 */
export function hasManifestEntry(entries: readonly WalkedEntry[]): boolean {
  return entries.some((e) => e.isFile() && (e.name === PLUGIN_MANIFEST_FILE || e.name === BUNDLE_FILE));
}

/**
 * The questions BOTH plugin-shaped startup steps ask of the tree: is this
 * folder a plugin from before manifests existed, and does a real plugin live
 * beneath it?
 *
 * Two steps need these answers — the manifest back-fill and the
 * Groups→Plugins migration — and they must never disagree, or one would write
 * a manifest into a folder the other treats as a grouping folder. They used
 * to share the answers as free functions taking the walker, which put the
 * port in every signature and every call. Injected once instead: the walker
 * is a constructor dependency, as an INTERFACE, and the questions read as
 * questions.
 */
export class PluginLayout {
  constructor(private readonly disk: ITreeWalker) {}

  /**
   * Whether a folder's own content is what the legacy layout put in a plugin
   * — THE rule for "this folder was a plugin before manifests existed". A
   * folder with nothing of the kind (a `.gitkeep`, a grouping folder someone
   * made in the tree) is not.
   *
   * Entries the walk SKIPS are not content. The two callers reach this with
   * listings of different provenance — the manifest step's come from a walk
   * that has already dropped dot-entries and `node_modules`, the migration's
   * come raw from `listDir` — and judging the raw ones as they arrived made
   * a folder holding nothing but `.hidden.tool` a plugin: the migration wrote
   * it a manifest and then moved nothing into it, because its own sweep skips
   * exactly what this had counted. Filtered HERE rather than at that call
   * site, so the answer cannot depend on which door it came through.
   */
  async looksLikeLegacyPlugin(dir: string, entries: readonly WalkedEntry[]): Promise<boolean> {
    for (const entry of entries) {
      if (isSkippedEntry(entry.name)) continue;
      if (
        entry.isFile() &&
        (entry.name === 'access.md' || entry.name === PLUGIN_MCP_FILE || entry.name.toLowerCase().endsWith('.tool'))
      ) {
        return true;
      }
      if (entry.isDirectory() && (entry.name === PLUGIN_SKILLS_DIR || entry.name === HEXIS_EXTENSION_NS)) return true;
    }
    return this.hasSkillBeneath(dir);
  }

  /**
   * Whether a plugin (a folder carrying `plugin.json` or a bundle) sits
   * anywhere BELOW `dir` — which makes `dir` a grouping folder, never a
   * plugin itself.
   *
   * Judged the way discovery judges it: a manifest is a REGULAR file entry
   * (`Dirent.isFile()` — a symlink so named is not one, exactly as the walk
   * behind the catalog sees it), and the entries the walk skips (dot-folders,
   * `node_modules`) hold nothing here either. Anything looser would let an
   * ignored or unsupported entry hide a legacy plugin from its manifest.
   */
  async hasPluginBeneath(dir: string): Promise<boolean> {
    return this.anyFolderIn(dir, (rel, entries) => rel !== '' && hasManifestEntry(entries));
  }

  /** The pre-`skills/` shape: `Plugins/<Plugin>/<skill>/SKILL.md`, at any depth (`dir` itself included). */
  private async hasSkillBeneath(dir: string): Promise<boolean> {
    return this.anyFolderIn(dir, (_rel, entries) => entries.some((e) => e.isFile() && e.name === 'SKILL.md'));
  }

  /**
   * Whether any folder at or under `dir` — walked as the catalog walks it, so
   * a SKILL.md vendored under `node_modules` is nobody's skill and makes no
   * folder a plugin — has a listing that satisfies `test`. Stops at the
   * first. A missing `dir` has none; a folder that cannot be listed is the
   * error.
   */
  private async anyFolderIn(
    dir: string,
    test: (rel: string, entries: readonly WalkedEntry[]) => boolean,
  ): Promise<boolean> {
    let found = false;
    await this.disk.walkKb(
      dir,
      [
        {
          onDir(rel, entries) {
            if (test(rel, entries)) found = true;
          },
        },
      ],
      { until: () => found, unreadable: 'throw' },
    );
    return found;
  }
}
