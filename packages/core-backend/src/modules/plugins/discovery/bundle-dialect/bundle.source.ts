import fs from 'node:fs/promises';
import path from 'node:path';
import { PLUGINS_DIR, normalizeSkillRoot, pluginManifestName } from '@bevel-software/platform-shared';
import { walkFiles } from '../../../../shared/fs-walk.js';
import type { DiscoveredPlugin, Discovery, PluginSource } from '../plugin-source.js';
import { expandProfile, parseRegistry, type McpRegistry } from './registry.js';

/**
 * THE DETACHABLE PART — a customer's plugin source format, read as-is:
 *
 *   <pluginsRoot>/<scope…>/<plugin>/plugin.bundle.json
 *     {
 *       "name": "example-plugin", "version": "1.3.1", "description": "…",
 *       "mcpProfile": "global",
 *       "interface": { "displayName": "Example Plugin", "category": "…" },
 *       "sourceSkillRoots": [ "skills/departments/engineering/shared/<cluster>" ]
 *     }
 *
 * A bundle is a LIST OF SKILL PATHS plus a pointer into an MCP registry, at
 * any depth under the plugins root — which is exactly the native model's
 * "a plugin links skills" with different field names. So the dialect maps:
 *
 *   sourceSkillRoots   → linkedRoots          (a root is a skill or a folder of skills)
 *   mcpProfile         → mcpServers           (expanded through the registry)
 *   name/version/desc  → a synthesised manifest
 *   interface.displayName → the plugin's display name
 *
 * READ-ONLY by construction: nothing in this directory writes. A plugin
 * created in hexis inside such a KB gets a native manifest from the native
 * writers; this source will not see it, the native one would. Their links
 * are plain references (`linksAreManaged: false`): no principal grant is
 * written or checked, the skills' own scopes decide readability.
 *
 * Deleting the dialect later = this directory, its setting, and the one
 * switch arm in the composition root.
 */
export const BUNDLE_FILE = 'plugin.bundle.json';
export const DEFAULT_REGISTRY_PATH = 'configs/mcp/registry.json';

export class BundlePluginSource implements PluginSource {
  readonly dialect = 'bundle';

  constructor(private readonly registryPath: string = DEFAULT_REGISTRY_PATH) {}

  async discover(kbRoot: string): Promise<Discovery> {
    const warnings: string[] = [];
    const registry = await this.loadRegistry(kbRoot, warnings);
    const root = path.join(kbRoot, PLUGINS_DIR);
    const plugins: DiscoveredPlugin[] = [];
    const seen = new Map<string, string>();
    for (const rel of await walkFiles(root, (name) => name === BUNDLE_FILE)) {
      const relFolder = path.posix.dirname(rel.replace(/\\/g, '/'));
      const folder = relFolder === '.' ? PLUGINS_DIR : `${PLUGINS_DIR}/${relFolder}`;
      let bundle: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(path.join(root, rel), 'utf-8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
        bundle = parsed as Record<string, unknown>;
      } catch {
        warnings.push(`${folder}/${BUNDLE_FILE} is not a JSON object — plugin skipped`);
        continue;
      }
      const leaf = path.posix.basename(relFolder);
      const name = typeof bundle.name === 'string' && bundle.name.trim() ? bundle.name.trim() : leaf;
      const twin = seen.get(name);
      if (twin) {
        warnings.push(`${folder}: bundle name "${name}" is already used by ${twin} — plugin skipped`);
        continue;
      }
      seen.set(name, folder);

      const linkedRoots: string[] = [];
      for (const raw of Array.isArray(bundle.sourceSkillRoots) ? bundle.sourceSkillRoots : []) {
        const normalised = normalizeSkillRoot(typeof raw === 'string' ? raw : '');
        if (normalised === null) warnings.push(`${folder}: sourceSkillRoots entry ${JSON.stringify(raw)} is not a folder path — ignored`);
        else if (!linkedRoots.includes(normalised)) linkedRoots.push(normalised);
      }

      let mcpServers: Record<string, unknown> | null = null;
      if (typeof bundle.mcpProfile === 'string' && bundle.mcpProfile.trim()) {
        if (!registry) {
          warnings.push(`${folder}: mcpProfile "${bundle.mcpProfile}" named but no registry could be read`);
        } else {
          const expanded = expandProfile(registry, bundle.mcpProfile.trim());
          warnings.push(...expanded.warnings.map((w) => `${folder}: ${w}`));
          if (Object.keys(expanded.mcpServers).length > 0) mcpServers = expanded.mcpServers;
        }
      }

      const ui = typeof bundle.interface === 'object' && bundle.interface !== null ? (bundle.interface as Record<string, unknown>) : {};
      const manifest: Record<string, unknown> = { name: pluginManifestName(name) };
      if (typeof bundle.version === 'string') manifest.version = bundle.version;
      if (typeof bundle.description === 'string') manifest.description = bundle.description;
      if (typeof ui.displayName === 'string') manifest.displayName = ui.displayName;

      plugins.push({
        name,
        folder,
        relFolder: relFolder === '.' ? '' : relFolder,
        personal: false,
        exists: true,
        manifest,
        manifestText: null,
        linkedRoots,
        mcpServers,
        mcpJsonText: mcpServers ? JSON.stringify({ mcpServers }) : null,
        linksAreManaged: false,
      });
    }
    return { plugins, warnings };
  }

  private async loadRegistry(kbRoot: string, warnings: string[]): Promise<McpRegistry | null> {
    let text: string;
    try {
      text = await fs.readFile(path.join(kbRoot, this.registryPath), 'utf-8');
    } catch {
      return null; // no registry: bundles without a profile are still plugins
    }
    const registry = parseRegistry(text);
    warnings.push(...registry.warnings);
    return registry;
  }
}
