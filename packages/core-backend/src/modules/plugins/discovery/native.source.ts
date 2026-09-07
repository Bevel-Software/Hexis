import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  isPersonalPluginDir,
  isPluginIdentifier,
  linkedSkillRoots,
  pluginDisplayNameOf,
  pluginIdentityOf,
} from '@bevel-software/platform-shared';
import { isAbsence } from '../../../shared/fs-errors.js';
import type { DiscoveredPlugin } from './plugin-source.js';

/**
 * A plugin in the layout this platform writes (see `kb-layout.ts`): a folder
 * carrying `plugin.json`, optionally `mcp.json`, and the `access.md` that
 * makes it exist to the index. Called by the walker for every folder it
 * decides is a native plugin; reads the files, decides nothing else.
 */
export async function readNativePlugin(
  dir: string,
  folder: string,
  relFolder: string,
  warnings: string[],
  unreadable: string[],
): Promise<DiscoveredPlugin> {
  const folderName = path.posix.basename(relFolder);
  const manifestText = await readText(path.join(dir, PLUGIN_MANIFEST_FILE), folder, warnings, unreadable);
  const mcpJsonText = await readText(path.join(dir, PLUGIN_MCP_FILE), folder, warnings, unreadable);
  const manifest = parseObject(manifestText);
  if (manifestText !== null && manifest === null) {
    warnings.push(`${folder}/${PLUGIN_MANIFEST_FILE} is not a JSON object — treated as absent`);
  }
  // The manifest's `name` IS the identity — the grants, the URLs, the
  // marketplace all spell it — when it is an identifier. One that is not
  // (spaces, capitals) is never silently reinterpreted: the folder stands
  // in, and the mismatch is said out loud so a grant written against the
  // manifest's spelling is not a mystery.
  const name = pluginIdentityOf(manifest, folderName);
  const displayName = pluginDisplayNameOf(manifest, folderName);
  // Any PRESENT name that is not an identifier is worth a word — a number or
  // an object as much as a capitalised string. Only an absent name is silent.
  if (manifest && manifest.name !== undefined && !isPluginIdentifier(manifest.name)) {
    const spelled = typeof manifest.name === 'string' ? `"${manifest.name}"` : JSON.stringify(manifest.name);
    warnings.push(
      `${folder}/${PLUGIN_MANIFEST_FILE} names ${spelled}, which is not a plugin identifier (lowercase kebab-case) — the folder stands in as "${name}"`,
    );
  }
  const mcp = parseObject(mcpJsonText);
  const mcpServers =
    mcp && typeof mcp.mcpServers === 'object' && mcp.mcpServers !== null && !Array.isArray(mcp.mcpServers)
      ? (mcp.mcpServers as Record<string, unknown>)
      : null;
  const exists = await fs.stat(path.join(dir, 'access.md')).then((s) => s.isFile(), () => false);
  return {
    name,
    displayName,
    folder,
    relFolder,
    // The one structural rule: a direct child of the root with the prefix.
    personal: isPersonalPluginDir(folder),
    exists,
    manifest,
    manifestText,
    linkedRoots: linkedSkillRoots(manifest),
    mcpServers,
    mcpJsonText,
    linksAreManaged: true,
  };
}

/**
 * A file's text, or null when there is no such file. A file that is there
 * but cannot be read is ALSO null to the caller — the plugin still stands,
 * on its folder's name — but it is said and counted: a manifest nobody could
 * read is an identity nobody could see.
 */
async function readText(abs: string, folder: string, warnings: string[], unreadable: string[]): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf-8');
  } catch (err) {
    if (!isAbsence(err)) {
      warnings.push(`${folder}/${path.basename(abs)} could not be read — ${err instanceof Error ? err.message : String(err)}`);
      unreadable.push(`${folder}/${path.basename(abs)}`);
    }
    return null;
  }
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
