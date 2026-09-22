import path from 'node:path';
import { PLUGINS_DIR, PLUGIN_MANIFEST_FILE, renderPluginManifest } from '@bevel-software/platform-shared';
import type { ITreeWalker, WalkedEntry } from '../../../../shared/fs.contract.js';
import { PluginLayout, hasManifestEntry } from './plugin-layout.js';
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
 * anywhere beneath (the pre-`skills/` shape) — see {@link PluginLayout},
 * which the Groups→Plugins migration reads the same answers from.
 *
 * Every branch, drafts included, like the Groups→Plugins migration and for
 * the same reason: a draft migrated alongside its target diffs by the user's
 * own changes only. Idempotent: a folder that has its manifest is skipped.
 */
export class PluginManifestsStep implements OnServerStart {
  readonly name = 'plugin-manifests';

  private readonly layout: PluginLayout;

  constructor(private readonly disk: ITreeWalker) {
    this.layout = new PluginLayout(disk);
  }

  async run(ctx: ServerStartContext): Promise<StepResult> {
    for (const branch of await ctx.allBranches()) {
      await this.addManifests(branch);
    }
    return { outcome: 'ok' };
  }

  private async addManifests(branch: KbBranch): Promise<void> {
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
    await this.disk.walkKb(
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
      if (!(await this.layout.looksLikeLegacyPlugin(path.join(root, rel), entries))) continue;
      branch.write(`${PLUGINS_DIR}/${rel}/${PLUGIN_MANIFEST_FILE}`, renderPluginManifest(rel));
      added.push(rel);
    }
    if (added.length === 0) return;
    branch.note(
      `Add plugin manifests to ${added.length === 1 ? 'a legacy plugin folder' : `${added.length} legacy plugin folders`}`,
    );
    for (const rel of added) branch.note(`${PLUGINS_DIR}/${rel}: ${PLUGIN_MANIFEST_FILE} written`);
  }
}
