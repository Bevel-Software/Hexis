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
 *
 * Null when the manifest exists but could not be READ: the manifest is the
 * identity, and a plugin whose identity nobody could see is not listed under
 * a guessed one — it is a hole (`unreadable`), like a folder that could not
 * be listed. The optional `mcp.json` carries no identity, so its read
 * failure is a warning and nothing more.
 */
export async function readNativePlugin(
  dir: string,
  folder: string,
  relFolder: string,
  warnings: string[],
  unreadable: string[],
): Promise<DiscoveredPlugin | null> {
  const folderName = path.posix.basename(relFolder);
  const manifestRead = await readText(path.join(dir, PLUGIN_MANIFEST_FILE), folder, warnings);
  if (manifestRead.failed) {
    unreadable.push(`${folder}/${PLUGIN_MANIFEST_FILE}`);
    return null;
  }
  // The walker probed the manifest a moment ago; gone now means it vanished
  // between probe and read — then this is no plugin, not one under a guessed name.
  if (manifestRead.text === null) return null;
  const manifestText = manifestRead.text;
  const mcpJsonText = (await readText(path.join(dir, PLUGIN_MCP_FILE), folder, warnings)).text;
  const manifest = parseObject(manifestText);
  if (manifest === null) {
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
 * A file's text — null when there is no such file — and whether a file that
 * IS there could not be read. Absence and failure are different answers;
 * the caller decides what a failure means for the file in question.
 */
async function readText(
  abs: string,
  folder: string,
  warnings: string[],
): Promise<{ text: string | null; failed: boolean }> {
  try {
    return { text: await fs.readFile(abs, 'utf-8'), failed: false };
  } catch (err) {
    if (isAbsence(err)) return { text: null, failed: false };
    warnings.push(`${folder}/${path.basename(abs)} could not be read — ${err instanceof Error ? err.message : String(err)}`);
    return { text: null, failed: true };
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
