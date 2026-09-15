import path from 'node:path';
import {
  HEXIS_EXTENSION_NS,
  PLUGINS_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  PLUGIN_SKILLS_DIR,
  renderPluginManifest,
} from '@bevel-software/platform-shared';
import { BUNDLE_FILE } from '../../../plugins/discovery/bundle-dialect/bundle.source.js';
import type { ITreeWalker, WalkedEntry } from '../../../../shared/fs.contract.js';
import type { KbBranch, OnServerStart, ServerStartContext, StepResult } from '../on-server-start.js';

/**
 * Give every legacy plugin folder its manifest, as an {@link OnServerStart}
 * step.
 *
 * A plugin IS a folder carrying `plugin.json` (or a `plugin.bundle.json`, the
 * read-only customer dialect) — discovery reads nothing else, at any depth.
 * Folders from before the manifest existed have `access.md`, an `mcp.json`,
 * a `skills/` tree or `.tool` manuals and no `plugin.json` beside them; the
 * old scanners read those by position (directly under the plugins root),
 * and this step is what retires that rule: it writes the minimal manifest
 * into each such folder, once, so the position never has to mean anything
 * again.
 *
 * WHICH folders: walk the plugins root; a folder holding either file is a
 * plugin and is not entered. Any other folder is entered first. A folder
 * DIRECTLY under the root — the only place the legacy layout ever put a
 * plugin — becomes one when nothing plugin-shaped lives beneath it and its
 * own content is legacy content: a scope folder (the dialect's
 * `plugins/functional/…`) can carry an `access.md` of its own and must stay
 * a scope, and a skill folder inside a legacy plugin must not become a
 * plugin of its own. "Legacy content" is the set of things provisioning and
 * the old migration ever put in a plugin folder: `access.md`, `mcp.json`,
 * `skills/`, the hexis extension directory, a `.tool` file, or a `SKILL.md`
 * anywhere beneath (the pre-`skills/` shape).
 *
 * Every branch, drafts included, like the Groups→Plugins migration and for
 * the same reason: a draft migrated alongside its target diffs by the user's
 * own changes only. Idempotent: a folder that has its manifest is skipped.
 */
export class PluginManifestsStep implements OnServerStart {
  readonly name = 'plugin-manifests';

  constructor(private readonly disk: ITreeWalker) {}

  async run(ctx: ServerStartContext): Promise<StepResult> {
    for (const branch of await ctx.allBranches()) {
      await addManifests(this.disk, branch);
    }
    return { outcome: 'ok' };
  }
}

async function addManifests(disk: ITreeWalker, branch: KbBranch): Promise<void> {
  const repoDir = await branch.repoDir();
  const root = path.join(repoDir, PLUGINS_DIR);
  const added: string[] = [];

  // A plugin is a folder whose OWN listing holds a manifest as a regular
  // file — the judgement discovery makes, entry for entry (a symlink so
  // named is none) — and a leaf: nothing beneath it is a plugin. Absence is
  // the plugins root not existing yet; any other hole must stop the boot
  // rather than quietly leave legacy plugins without manifests.
  const plugins: string[] = [];
  const topLevel: { rel: string; entries: readonly WalkedEntry[] }[] = [];
  await disk.walkKb(
    root,
    [
      {
        onDir(rel, entries) {
          if (rel && hasManifestEntry(entries)) plugins.push(rel);
          else if (rel && !rel.includes('/')) topLevel.push({ rel, entries });
        },
      },
    ],
    { leaf: (dir, entries) => dir.rel !== '' && hasManifestEntry(entries), unreadable: 'throw' },
  );
  for (const { rel, entries } of topLevel) {
    // A grouping folder — plugins beneath it — is never a plugin itself.
    if (plugins.some((p) => p.startsWith(`${rel}/`))) continue;
    if (!(await looksLikeLegacyPlugin(disk, path.join(root, rel), entries))) continue;
    branch.write(`${PLUGINS_DIR}/${rel}/${PLUGIN_MANIFEST_FILE}`, renderPluginManifest(rel));
    added.push(rel);
  }
  if (added.length === 0) return;
  branch.note(`Add plugin manifests to ${added.length === 1 ? 'a legacy plugin folder' : `${added.length} legacy plugin folders`}`);
  for (const rel of added) branch.note(`${PLUGINS_DIR}/${rel}: ${PLUGIN_MANIFEST_FILE} written`);
}

/**
 * Whether a folder's own content is what the legacy layout put in a plugin —
 * THE rule for "this folder was a plugin before manifests existed", shared
 * with the Groups→Plugins migration so the two steps cannot disagree about
 * which folders under the root are plugins. A folder with nothing of the
 * kind (a `.gitkeep`, a grouping folder someone made in the tree) is not.
 */
export async function looksLikeLegacyPlugin(disk: ITreeWalker, dir: string, entries: readonly WalkedEntry[]): Promise<boolean> {
  for (const entry of entries) {
    if (entry.isFile() && (entry.name === 'access.md' || entry.name === PLUGIN_MCP_FILE || entry.name.toLowerCase().endsWith('.tool'))) {
      return true;
    }
    if (entry.isDirectory() && (entry.name === PLUGIN_SKILLS_DIR || entry.name === HEXIS_EXTENSION_NS)) return true;
  }
  return hasSkillBeneath(disk, dir);
}

/**
 * Whether a plugin (a folder carrying `plugin.json` or a bundle) sits anywhere
 * BELOW `dir` — which makes `dir` a grouping folder, never a plugin itself.
 *
 * Judged the way discovery judges it: a manifest is a REGULAR file entry
 * (`Dirent.isFile()` — a symlink so named is not one, exactly as the walk
 * behind the catalog sees it), and the entries the walk skips (dot-folders,
 * `node_modules`) hold nothing here either. Anything looser would let an
 * ignored or unsupported entry hide a legacy plugin from its manifest.
 */
export async function hasPluginBeneath(disk: ITreeWalker, dir: string): Promise<boolean> {
  return anyFolderIn(disk, dir, (rel, entries) => rel !== '' && hasManifestEntry(entries));
}

/** Whether a folder's listing carries a plugin manifest or a bundle as a regular file. */
function hasManifestEntry(entries: readonly WalkedEntry[]): boolean {
  return entries.some((e) => e.isFile() && (e.name === PLUGIN_MANIFEST_FILE || e.name === BUNDLE_FILE));
}

/** The pre-`skills/` shape: `Plugins/<Plugin>/<skill>/SKILL.md`, at any depth (`dir` itself included). */
async function hasSkillBeneath(disk: ITreeWalker, dir: string): Promise<boolean> {
  return anyFolderIn(disk, dir, (_rel, entries) => entries.some((e) => e.isFile() && e.name === 'SKILL.md'));
}

/**
 * Whether any folder at or under `dir` — walked as the catalog walks it, so a
 * SKILL.md vendored under `node_modules` is nobody's skill and makes no folder
 * a plugin — has a listing that satisfies `test`. Stops at the first. A
 * missing `dir` has none; a folder that cannot be listed is the error.
 */
async function anyFolderIn(
  disk: ITreeWalker,
  dir: string,
  test: (rel: string, entries: readonly WalkedEntry[]) => boolean,
): Promise<boolean> {
  let found = false;
  await disk.walkKb(
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

