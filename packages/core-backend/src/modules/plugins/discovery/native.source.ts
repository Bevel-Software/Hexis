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
): Promise<DiscoveredPlugin> {
  const folderName = path.posix.basename(relFolder);
  const manifestText = await readText(path.join(dir, PLUGIN_MANIFEST_FILE));
  const mcpJsonText = await readText(path.join(dir, PLUGIN_MCP_FILE));
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

async function readText(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf-8');
  } catch {
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
