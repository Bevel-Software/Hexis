import fs from 'node:fs/promises';
import path from 'node:path';
import { PLUGINS_DIR, PLUGIN_MANIFEST_FILE, pluginManifestName } from '@bevel-software/platform-shared';
import type { DiscoveredPlugin, Discovery, PluginSource } from './plugin-source.js';
import { readNativePlugin } from './native.source.js';
import { BUNDLE_FILE, loadRegistry, readBundlePlugin } from './bundle-dialect/bundle.source.js';

/**
 * THE plugin source: walk the plugins root to any depth and read every plugin
 * folder in whichever of the two file shapes it carries.
 *
 *   plugin.json          → a native plugin (this platform's layout)
 *   plugin.bundle.json   → a bundle (the customer dialect, read-only)
 *
 * Nothing else is a plugin. A folder's POSITION means nothing: the legacy
 * rule "everything directly under the root is a plugin" is retired by the
 * `plugin-manifests` boot step, which writes the manifest into every such
 * folder once, so this walker never has to guess.
 *
 * A folder that IS a plugin is not descended into (its `skills/` are its
 * own); every other folder is. When a folder carries both files the manifest
 * wins, so a bundle migrated in place stops being read as a bundle the moment
 * a `plugin.json` lands beside it. Two plugins with one name keep the first
 * by path and warn about the second — a name is an identity to people and
 * URLs, and two folders answering to it would be two plugins with one key.
 *
 * No setting picks a dialect. Nothing to configure means nothing to document
 * and nothing to remove but the `else if` that reads bundles.
 */
export class KbPluginSource implements PluginSource {
  readonly dialect = 'kb';

  async discover(kbRoot: string): Promise<Discovery> {
    const warnings: string[] = [];
    const plugins: DiscoveredPlugin[] = [];
    const root = path.join(kbRoot, PLUGINS_DIR);
    const registry = await loadRegistry(kbRoot, warnings);
    const seen = new Map<string, string>();

    // Uniqueness is judged on the MANIFEST SLUG, not the raw name: `Sales Team`
    // and `sales-team` fold to one slug, and the slug is what the compiled
    // marketplace keys a plugin on — two folders sharing it would be two
    // plugins with one key and one of them silently overwritten.
    const claim = (plugin: DiscoveredPlugin): void => {
      const key = pluginManifestName(plugin.name);
      const twin = seen.get(key);
      if (twin) {
        warnings.push(`${plugin.folder}: plugin name "${plugin.name}" is already used by ${twin} — plugin skipped`);
        return;
      }
      seen.set(key, plugin.folder);
      plugins.push(plugin);
    };

    /** Visit a folder; resolves to how many plugins were found at or beneath it. */
    const visit = async (dir: string, relFolder: string): Promise<number> => {
      const folder = relFolder ? `${PLUGINS_DIR}/${relFolder}` : PLUGINS_DIR;
      const isRoot = relFolder === '';
      if (!isRoot && (await isFile(path.join(dir, PLUGIN_MANIFEST_FILE)))) {
        claim(await readNativePlugin(dir, folder, relFolder, warnings));
        return 1;
      }
      if (!isRoot && (await isFile(path.join(dir, BUNDLE_FILE)))) {
        const bundle = await readBundlePlugin(dir, folder, relFolder, registry, warnings);
        if (bundle) claim(bundle);
        return 1; // unreadable: reported, and still not descended into
      }
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return 0;
      }
      let beneath = 0;
      for (const entry of entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))) {
        beneath += await visit(path.join(dir, entry.name), relFolder ? `${relFolder}/${entry.name}` : entry.name);
      }
      return beneath;
    };

    await visit(root, '');
    return { plugins, warnings };
  }
}

async function isFile(abs: string): Promise<boolean> {
  return fs.stat(abs).then((s) => s.isFile(), () => false);
}
