import path from 'node:path';
import {
  PLUGINS_DIR,
  PLUGIN_MANIFEST_FILE,
  pluginIdentityOf,
} from '@bevel-software/platform-shared';
import type { IFsProbe, ITreeWalker } from '../../../../shared/fs.contract.js';
import { hasManifestEntry } from './plugin-layout.js';
import type { KbBranch, OnServerStart, ServerStartContext, StepResult } from '../on-server-start.js';

/**
 * Write down what each existing plugin is already CALLED, as an
 * {@link OnServerStart} step.
 *
 * The display name is now the manifest's `displayName`, else its `name`, and
 * nothing else — the folder's spelling is no longer consulted by any reader
 * (see `pluginDisplayNameOf`). Before that rule, a manifest carried the field
 * only when the folder was spelled differently from the identifier, and every
 * reader fell back to the folder. So a knowledge base written under the old
 * rule holds manifests that say `{"name": "sales-team"}` inside a folder
 * called `Sales Team`: under the new rule alone they would start showing
 * `sales-team`, and the plugin would appear to have renamed itself on an
 * upgrade nobody asked for.
 *
 * This step is the one-time repair: for every manifest that LACKS the field
 * and whose folder is spelled differently from its identifier, the folder's
 * spelling is written into `displayName` — which is exactly what that plugin
 * was called the moment before the boot. Nothing else in the manifest moves.
 *
 * What it does NOT touch:
 *   - a manifest that already carries `displayName` — the field is the
 *     author's answer, and a migration that overwrote it would be renaming
 *     plugins rather than preserving names;
 *   - a manifest whose folder spelling already equals its identifier — under
 *     both rules it is called the same thing, so there is nothing to record,
 *     and writing the field would churn every plugin in the tree for no
 *     change anyone can see;
 *   - a bundle (`plugin.bundle.json`) — a foreign repository's file this
 *     platform reads and never writes.
 *
 * Every branch, drafts included, like the manifests step beside it and for
 * the same reason: a draft migrated alongside its target diffs by the user's
 * own changes only. Idempotent by construction — after a run, every manifest
 * it would touch carries the field, so the next boot finds nothing.
 */
export class PluginDisplayNamesStep implements OnServerStart {
  readonly name = 'plugin-display-names';

  constructor(private readonly disk: IFsProbe & ITreeWalker) {}

  async run(ctx: ServerStartContext): Promise<StepResult> {
    for (const branch of await ctx.allBranches()) {
      await this.backfill(branch);
    }
    return { outcome: 'ok' };
  }

  private async backfill(branch: KbBranch): Promise<void> {
    const repoDir = await branch.repoDir();
    const root = path.join(repoDir, PLUGINS_DIR);

    // Plugin folders by the judgement discovery makes, entry for entry: a
    // manifest as a REGULAR file, and nothing beneath a plugin is a plugin.
    // Absence is the plugins root not existing yet; any other hole stops the
    // boot rather than quietly leaving part of the tree unmigrated — a
    // plugin this step misses is one that renames itself the moment it is
    // read, which is the whole failure it exists to prevent.
    const plugins: string[] = [];
    await this.disk.walkKb(
      root,
      [
        {
          onDir(rel, entries) {
            if (rel && hasManifestEntry(entries)) plugins.push(rel);
          },
        },
      ],
      { leaf: (dir, entries) => dir.rel !== '' && hasManifestEntry(entries), unreadable: 'throw' },
    );

    const filled: string[] = [];
    for (const rel of plugins) {
      const manifestPath = path.join(root, ...rel.split('/'), PLUGIN_MANIFEST_FILE);
      // Null is "no native manifest here, or none this step can reason
      // about": a bundle-only folder, or a `plugin.json` that is not a JSON
      // object. Discovery already says so out loud; rewriting it blind would
      // be this step inventing a manifest for a file it could not read.
      const manifest = await this.disk.readJsonObject(manifestPath);
      if (manifest === null) continue;
      // The author's own answer, whatever it says. A field that is present
      // but blank is still present: the manifest was written deliberately,
      // and the reader's own fallback covers it.
      if ('displayName' in manifest) continue;
      const folderName = path.posix.basename(rel);
      // Spelled the same as the identifier: called the same thing under both
      // rules, so there is nothing the folder knows that the manifest does not.
      if (folderName === pluginIdentityOf(manifest, folderName)) continue;
      branch.write(
        `${PLUGINS_DIR}/${rel}/${PLUGIN_MANIFEST_FILE}`,
        `${JSON.stringify(withDisplayName(manifest, folderName), null, 2)}\n`,
      );
      filled.push(rel);
    }

    if (filled.length === 0) return;
    branch.note(
      filled.length === 1
        ? "Record a plugin's display name in its manifest"
        : `Record the display names of ${filled.length} plugins in their manifests`,
    );
    for (const rel of filled) branch.note(`${PLUGINS_DIR}/${rel}: displayName "${path.posix.basename(rel)}"`);
  }
}

/**
 * The manifest with `displayName` set, placed directly after `name` — where
 * the renderer writes it — so a backfilled manifest and a freshly created one
 * read the same. Every other key keeps its place and its value.
 */
function withDisplayName(manifest: Record<string, unknown>, displayName: string): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    next[key] = value;
    if (key === 'name') next.displayName = displayName;
  }
  // A manifest with no `name` at all: the field still belongs in it — the
  // folder's spelling is what the plugin was called — and discovery stands
  // the folder in as the identity, so the two agree.
  if (!('displayName' in next)) next.displayName = displayName;
  return next;
}
