import fs from 'node:fs/promises';
import path from 'node:path';
import { isPersonalPluginDir, normalizeSkillRoot, pluginManifestName } from '@bevel-software/platform-shared';
import { isAbsence } from '../../../../shared/fs.contract.js';
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The registry, when the repository has one; a missing file is null, a broken one warns. */
export async function loadRegistry(kbRoot: string, warnings: string[]): Promise<McpRegistry | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(kbRoot, DEFAULT_REGISTRY_PATH), 'utf-8');
  } catch (err) {
    // No registry is a valid state: bundles without a profile are still
    // plugins. A registry that exists but cannot be read is not.
    if (!isAbsence(err)) {
      const code = (err as { code?: unknown } | null)?.code;
      warnings.push(`${DEFAULT_REGISTRY_PATH} could not be read (${String(code ?? err)}) — every mcpProfile is unresolved`);
    }
    return null;
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
  unreadable: string[],
): Promise<DiscoveredPlugin | null> {
  // Reading and parsing are two failures with two meanings: a file that
  // cannot be read is a plugin nobody could see (counted, so a writer can
  // refuse); a file that is not a bundle is a plugin that is not there.
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, BUNDLE_FILE), 'utf-8');
  } catch (err) {
    if (!isAbsence(err)) {
      warnings.push(`${folder}/${BUNDLE_FILE} could not be read — ${err instanceof Error ? err.message : String(err)}`);
      unreadable.push(`${folder}/${BUNDLE_FILE}`);
    }
    return null;
  }
  let bundle: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
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

  // A record, or nothing: a list where the block should be is not a block.
  const ui = isRecord(bundle.interface) ? bundle.interface : {};
  // The bundle's own rule for what it is called: `interface.displayName`,
  // else the FOLDER — this dialect is a foreign repository's, read-only, and
  // its folders are its presentation. The synthesized manifest carries the
  // answer so the shared reader (`pluginDisplayNameOf`, manifest-only) tells
  // anyone who asks the same thing this discovery reports.
  const displayName = typeof ui.displayName === 'string' && ui.displayName.trim() ? ui.displayName.trim() : leaf;
  // The presentation block is carried as written (below) — except for the
  // one field that is also a name: the block gets the SAME answer the
  // manifest does. The compile step fills `interface.displayName` only when
  // it is blank, so a padded or blank spelling left here would ship a Codex
  // manifest whose `interface` calls the plugin something the catalog and
  // the API do not — the split answer this whole rule removes.
  const carriedUi = typeof ui.displayName === 'string' ? { ...ui, displayName } : ui;
  const manifest: Record<string, unknown> = { name: pluginManifestName(name) };
  if (typeof bundle.version === 'string') manifest.version = bundle.version;
  if (typeof bundle.description === 'string') manifest.description = bundle.description;
  manifest.displayName = displayName;
  // What the bundle says about itself beyond the four fields above — who
  // wrote it, what it is for, how a catalogue should present it — is carried
  // as written, so the compiled plugin can say the same. Shapes are the
  // vendor manifests' own (`author` an object or a string, `keywords` a list,
  // `interface` the Codex presentation block); anything else is left where it is.
  if (isRecord(bundle.author) || typeof bundle.author === 'string') manifest.author = bundle.author;
  if (Array.isArray(bundle.keywords) && bundle.keywords.every((k) => typeof k === 'string')) manifest.keywords = bundle.keywords;
  if (Object.keys(carriedUi).length > 0) manifest.interface = carriedUi;

  return {
    name,
    displayName,
    folder,
    relFolder,
    // The same rule as the native reader: a reserved personal folder directly
    // under the root is a place, not a plugin, whatever file it carries.
    personal: isPersonalPluginDir(folder),
    exists: true,
    manifest,
    manifestText: null,
    linkedRoots,
    mcpServers,
    mcpJsonText: mcpServers ? JSON.stringify({ mcpServers }) : null,
    linksAreManaged: false,
  };
}
