import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  isPersonalPluginFolder,
  linkedSkillRoots,
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
  const name = path.posix.basename(relFolder);
  const manifestText = await readText(path.join(dir, PLUGIN_MANIFEST_FILE));
  const mcpJsonText = await readText(path.join(dir, PLUGIN_MCP_FILE));
  const manifest = parseObject(manifestText);
  if (manifestText !== null && manifest === null) {
    warnings.push(`${folder}/${PLUGIN_MANIFEST_FILE} is not a JSON object — treated as absent`);
  }
  const mcp = parseObject(mcpJsonText);
  const mcpServers =
    mcp && typeof mcp.mcpServers === 'object' && mcp.mcpServers !== null && !Array.isArray(mcp.mcpServers)
      ? (mcp.mcpServers as Record<string, unknown>)
      : null;
  const exists = await fs.stat(path.join(dir, 'access.md')).then((s) => s.isFile(), () => false);
  return {
    name,
    folder,
    relFolder,
    // Personal folders sit directly under the root; a deeper `personal-x` is just a name.
    personal: !relFolder.includes('/') && isPersonalPluginFolder(name),
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
