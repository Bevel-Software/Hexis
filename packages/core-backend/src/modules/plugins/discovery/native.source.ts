import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PLUGINS_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  isPersonalPluginFolder,
  linkedSkillRoots,
} from '@bevel-software/platform-shared';
import type { DiscoveredPlugin, Discovery, PluginSource } from './plugin-source.js';

/**
 * The layout this platform writes (see `kb-layout.ts`): one folder per
 * plugin directly under the plugins root, carrying `plugin.json`, optionally
 * `mcp.json`, and the `access.md` that makes it exist to the index.
 */
export class NativePluginSource implements PluginSource {
  readonly dialect = 'native';

  async discover(kbRoot: string): Promise<Discovery> {
    const root = path.join(kbRoot, PLUGINS_DIR);
    const warnings: string[] = [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return { plugins: [], warnings }; // no plugins root — nothing to discover
    }
    const plugins: DiscoveredPlugin[] = [];
    for (const entry of entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = path.join(root, entry.name);
      const manifestText = await readText(path.join(dir, PLUGIN_MANIFEST_FILE));
      const mcpJsonText = await readText(path.join(dir, PLUGIN_MCP_FILE));
      const manifest = parseObject(manifestText);
      if (manifestText !== null && manifest === null) {
        warnings.push(`${PLUGINS_DIR}/${entry.name}/${PLUGIN_MANIFEST_FILE} is not a JSON object — treated as absent`);
      }
      const mcp = parseObject(mcpJsonText);
      const mcpServers =
        mcp && typeof mcp.mcpServers === 'object' && mcp.mcpServers !== null && !Array.isArray(mcp.mcpServers)
          ? (mcp.mcpServers as Record<string, unknown>)
          : null;
      const exists = await fs
        .stat(path.join(dir, 'access.md'))
        .then((s) => s.isFile(), () => false);
      plugins.push({
        name: entry.name,
        folder: `${PLUGINS_DIR}/${entry.name}`,
        relFolder: entry.name,
        personal: isPersonalPluginFolder(entry.name),
        exists,
        manifest,
        manifestText,
        linkedRoots: linkedSkillRoots(manifest),
        mcpServers,
        mcpJsonText,
        linksAreManaged: true,
      });
    }
    return { plugins, warnings };
  }
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
