import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeSkillRoot, pluginManifestName } from '@bevel-software/platform-shared';
import type { DiscoveredPlugin } from '../plugin-source.js';
import { expandProfile, parseRegistry, type McpRegistry } from './registry.js';

/**
 * THE DETACHABLE PART — a customer's plugin file format, read as-is:
 *
 *   <pluginsRoot>/<scope…>/<plugin>/plugin.bundle.json
 *     {
 *       "name": "example-plugin", "version": "1.3.1", "description": "…",
 *       "mcpProfile": "global",
 *       "interface": { "displayName": "Example Plugin", "category": "…" },
 *       "sourceSkillRoots": [ "skills/departments/engineering/shared/<cluster>" ]
 *     }
 *
 * A bundle is a LIST OF SKILL PATHS plus a pointer into an MCP registry —
 * which is exactly the native model's "a plugin links skills" with different
 * field names. So the reader maps:
 *
 *   sourceSkillRoots   → linkedRoots          (a root is a skill or a folder of skills)
 *   mcpProfile         → mcpServers           (expanded through the registry)
 *   name/version/desc  → a synthesised manifest
 *   interface.displayName → the plugin's display name
 *
 * The walker (`kb-plugin-source.ts`) calls this for every folder holding a
 * bundle file; this reads the file and decides nothing else. READ-ONLY by
 * construction: nothing in this directory writes. A bundle's links are plain
 * references (`linksAreManaged: false`): no principal grant is written or
 * checked, the skills' own scopes decide readability.
 *
 * Deleting the dialect later = this directory, the one `else if` in the
 * walker that calls it, and the walker's registry load.
 */
export const BUNDLE_FILE = 'plugin.bundle.json';
export const DEFAULT_REGISTRY_PATH = 'configs/mcp/registry.json';

/** The registry, when the repository has one; a missing file is null, a broken one warns. */
export async function loadRegistry(kbRoot: string, warnings: string[]): Promise<McpRegistry | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(kbRoot, DEFAULT_REGISTRY_PATH), 'utf-8');
  } catch {
    return null; // no registry: bundles without a profile are still plugins
  }
  const registry = parseRegistry(text);
  warnings.push(...registry.warnings);
  return registry;
}

export async function readBundlePlugin(
  dir: string,
  folder: string,
  relFolder: string,
  registry: McpRegistry | null,
  warnings: string[],
): Promise<DiscoveredPlugin | null> {
  let bundle: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, BUNDLE_FILE), 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    bundle = parsed as Record<string, unknown>;
  } catch {
    warnings.push(`${folder}/${BUNDLE_FILE} is not a JSON object — plugin skipped`);
    return null;
  }
  const leaf = path.posix.basename(relFolder);
  const name = typeof bundle.name === 'string' && bundle.name.trim() ? bundle.name.trim() : leaf;

  const linkedRoots: string[] = [];
  for (const raw of Array.isArray(bundle.sourceSkillRoots) ? bundle.sourceSkillRoots : []) {
    const normalised = normalizeSkillRoot(typeof raw === 'string' ? raw : '');
    if (normalised === null) {
      warnings.push(`${folder}: sourceSkillRoots entry ${JSON.stringify(raw)} is not a folder path — ignored`);
    } else if (!linkedRoots.includes(normalised)) {
      linkedRoots.push(normalised);
    }
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

  const ui =
    typeof bundle.interface === 'object' && bundle.interface !== null
      ? (bundle.interface as Record<string, unknown>)
      : {};
  const manifest: Record<string, unknown> = { name: pluginManifestName(name) };
  if (typeof bundle.version === 'string') manifest.version = bundle.version;
  if (typeof bundle.description === 'string') manifest.description = bundle.description;
  if (typeof ui.displayName === 'string') manifest.displayName = ui.displayName;

  return {
    name,
    folder,
    relFolder,
    personal: false,
    exists: true,
    manifest,
    manifestText: null,
    linkedRoots,
    mcpServers,
    mcpJsonText: mcpServers ? JSON.stringify({ mcpServers }) : null,
    linksAreManaged: false,
  };
}
