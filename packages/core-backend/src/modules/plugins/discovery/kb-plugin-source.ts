import path from 'node:path';
import { PLUGINS_DIR, PLUGIN_MANIFEST_FILE, pluginManifestName } from '@bevel-software/platform-shared';
import type { DiscoveredPlugin, Discovery, PluginSource, PluginSourceWalk } from './plugin-source.js';
import { walkKb, type KbWalkListener } from '../../../shared/kb-walk.js';
import { readNativePlugin } from './native.source.js';
import { BUNDLE_FILE, loadRegistry, readBundlePlugin } from './bundle-dialect/bundle.source.js';
import type { McpRegistry } from './bundle-dialect/registry.js';

/**
 * THE plugin source: a LISTENER on the one walk of the checkout
 * (`walkKb`), reading every folder under the plugins root in whichever of
 * the two file shapes it carries.
 *
 *   plugin.json          → a native plugin (this platform's layout)
 *   plugin.bundle.json   → a bundle (the customer dialect, read-only)
 *
 * Nothing else is a plugin. A folder's POSITION means nothing: the legacy
 * rule "everything directly under the root is a plugin" is retired by the
 * `plugin-manifests` boot step, which writes the manifest into every such
 * folder once, so discovery never has to guess.
 *
 * A folder that IS a plugin claims everything beneath it (its `skills/` are
 * its own) — the walk still visits what lies beneath, for the other
 * listeners; this one ignores it. When a folder carries both files the
 * manifest wins, so a bundle migrated in place stops being read as a bundle
 * the moment a `plugin.json` lands beside it. Two plugins with one name keep
 * the first by path (the walk's order) and warn about the second — a name is
 * an identity to people and URLs, and two folders answering to it would be
 * two plugins with one key.
 *
 * Holes — a folder under the root that could not be listed, an identity
 * file that could not be read — are counted in `unreadable`: nothing behind
 * them is listed, and a writer refuses while they exist.
 *
 * No setting picks a dialect. Nothing to configure means nothing to document
 * and nothing to remove but the `else if` that reads bundles.
 */
export class KbPluginSource implements PluginSource {
  readonly dialect = 'kb';

  async discover(kbRoot: string): Promise<Discovery> {
    return (await this.walkWith(kbRoot, [])).discovery;
  }

  async walkWith(kbRoot: string, listeners: readonly KbWalkListener[]): Promise<PluginSourceWalk> {
    const warnings: string[] = [];
    const registry = await loadRegistry(kbRoot, warnings);
    const listener = pluginListener(kbRoot, registry, warnings);
    const { holes } = await walkKb(kbRoot, [listener.listener, ...listeners]);
    return { discovery: listener.result(), holes };
  }
}

/** The discovery listener over one walk, and the `Discovery` it has built once the walk is done. */
function pluginListener(
  kbRoot: string,
  registry: McpRegistry | null,
  warnings: string[],
): { listener: KbWalkListener; result(): Discovery } {
  const unreadable: string[] = [];
  const plugins: DiscoveredPlugin[] = [];
  const seen = new Map<string, string>();
  /** Folders claimed as plugins (or as holes standing where a plugin may be): nothing beneath is looked at. */
  const claimed: string[] = [];

  const underRoot = (rel: string) => rel === PLUGINS_DIR || rel.startsWith(`${PLUGINS_DIR}/`);
  const beneathClaimed = (rel: string) => claimed.some((c) => rel === c || rel.startsWith(`${c}/`));

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

  return {
    listener: {
      async onDir(rel, entries) {
        if (!underRoot(rel) || rel === PLUGINS_DIR || beneathClaimed(rel)) return;
        const has = (name: string) => entries.some((e) => e.isFile() && e.name === name);
        const dir = path.join(kbRoot, rel);
        const relFolder = rel.slice(PLUGINS_DIR.length + 1);
        if (has(PLUGIN_MANIFEST_FILE)) {
          claimed.push(rel);
          // A manifest that could not be read: a hole, and still claimed.
          const native = await readNativePlugin(dir, rel, relFolder, warnings, unreadable);
          if (native) claim(native);
        } else if (has(BUNDLE_FILE)) {
          claimed.push(rel);
          const bundle = await readBundlePlugin(dir, rel, relFolder, registry, warnings, unreadable);
          if (bundle) claim(bundle);
        }
      },
      onHole(rel, err) {
        // A folder under the root that could not be listed hides every plugin
        // beneath it; said out loud rather than letting the catalog shrink in
        // silence, and COUNTED so a writer can tell an incomplete listing from
        // a complete one. (Holes elsewhere in the tree are the walk's to report.)
        if (!underRoot(rel) || beneathClaimed(rel)) return;
        warnings.push(`${rel}: could not be read — ${err instanceof Error ? err.message : String(err)}`);
        unreadable.push(rel);
      },
    },
    result: () => ({ plugins, warnings, unreadable }),
  };
}
