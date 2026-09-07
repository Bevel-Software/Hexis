import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  isPersonalPluginFolder,
  linkedSkillRoots,
  pluginManifestName,
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
  // Two names govern two things. The FOLDER is the plugin's identity for
  // ACCESS — the catalog, the plugin principals (`plugin/<folder>/<verb>`),
  // the link grants. The manifest's `name` is what the compiled marketplace
  // publishes the plugin as, per the plugin spec. When they differ, a grant
  // written against the published name reaches nobody, so the mismatch is
  // said out loud.
  if (manifest && typeof manifest.name === 'string' && pluginManifestName(manifest.name) !== pluginManifestName(name)) {
    warnings.push(
      `${folder}/${PLUGIN_MANIFEST_FILE} names "${manifest.name}" while the folder is "${name}": access principals follow the FOLDER (plugin/${name}/read) — the marketplace publishes it as "${pluginManifestName(manifest.name)}"`,
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
