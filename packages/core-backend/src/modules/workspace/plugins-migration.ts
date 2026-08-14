import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HEXIS_TOOLS_DIR,
  LEGACY_GROUPS_DIR,
  PLUGINS_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  PLUGIN_MCP_SCHEMA,
  PLUGIN_SKILLS_DIR,
  renderPluginManifest,
} from '@bevel-software/platform-shared';
import { normalizeToolManual } from '../tool-manuals/tool-manuals.service.js';

/**
 * One-way migration of a knowledge base from `Groups/` to the Agent Plugins
 * layout under `Plugins/` (https://agent-plugins.org, v1.0.0).
 *
 * Runs from the seed top-up, so every deployment self-heals on the next load of
 * a protected branch — including the ones nobody remembers to migrate. It is
 * idempotent: a KB already on the new layout is untouched, and a half-finished
 * run (the process died between steps) is completed by the next one.
 *
 * What moves:
 *
 *   Groups/GTM/access.md            → Plugins/GTM/access.md              (stays put)
 *   Groups/GTM/deploy/SKILL.md      → Plugins/GTM/skills/deploy/SKILL.md
 *   Groups/GTM/notion.tool          → Plugins/GTM/software.bevel.hexis/tools/notion.tool
 *                                   → and, for `mcp` manuals, an entry in Plugins/GTM/mcp.json
 *                                     Plugins/GTM/plugin.json            (written)
 *
 * `.tool` files MOVE rather than convert, including the `mcp` ones. A manual
 * carries things `mcp.json` has no field for — its per-file access verbs, and
 * the `id` that secrets are namespaced under — so converting would silently
 * drop a tool's access rules and unbind its configured secrets. `mcp.json` is
 * therefore a PROJECTION of the mcp-type manuals, written so a conformant
 * client can see the servers; the `.tool` remains what this platform reads.
 */

/** A repo-relative path the caller should stage, plus what happened, for the log. */
export interface PluginsMigrationResult {
  migrated: boolean;
  /** Human-readable summary lines (plugin names, tool moves) for the seed log. */
  notes: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Move `from` to `to`, creating the parent. Never overwrites: a destination
 * that already exists means a previous run got there first (or a human did),
 * and clobbering it would destroy the newer copy.
 */
async function moveIfAbsent(from: string, to: string): Promise<boolean> {
  if (await exists(to)) return false;
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
  return true;
}

/**
 * The mcp.json projection of a plugin's `mcp`-type manuals.
 *
 * `streamable-http` for every entry: a `.tool` of type `mcp` names a remote
 * HTTP endpoint, which is exactly that transport. The legacy `sse` variant is
 * never emitted — nothing in a `.tool` distinguishes it, and guessing would
 * produce a config that fails at connect time.
 *
 * Values may still contain `${VAR}` references to the Secrets Vault. Those are
 * OURS, not the spec's (which defines only `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`),
 * so another client reads them literally and the call fails at the provider.
 * That is inherent to a server-side vault: the secret cannot be in the file.
 */
function renderMcpJson(servers: { name: string; url: string; headers?: Record<string, string> }[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers.sort((a, b) => a.name.localeCompare(b.name))) {
    mcpServers[s.name] = {
      type: 'streamable-http',
      url: s.url,
      ...(s.headers && Object.keys(s.headers).length > 0 ? { headers: s.headers } : {}),
    };
  }
  return `${JSON.stringify({ $schema: PLUGIN_MCP_SCHEMA, mcpServers }, null, 2)}\n`;
}

/** Reorganise ONE plugin folder in place. Returns notes describing what changed. */
async function migratePluginFolder(pluginDir: string, folderName: string): Promise<string[]> {
  const notes: string[] = [];

  if (!(await exists(path.join(pluginDir, PLUGIN_MANIFEST_FILE)))) {
    await fs.writeFile(
      path.join(pluginDir, PLUGIN_MANIFEST_FILE),
      renderPluginManifest(folderName),
      'utf8',
    );
    notes.push(`${folderName}: wrote ${PLUGIN_MANIFEST_FILE}`);
  }

  const entries = await fs.readdir(pluginDir, { withFileTypes: true });
  const mcpServers: { name: string; url: string; headers?: Record<string, string> }[] = [];

  for (const entry of entries) {
    // Dot-prefixed entries are parked/ignored by every scanner; the two fixed
    // locations and our namespace are already where they belong.
    if (entry.name.startsWith('.')) continue;
    if (entry.name === PLUGIN_SKILLS_DIR || entry.name === PLUGIN_MANIFEST_FILE) continue;
    if (entry.name === PLUGIN_MCP_FILE || entry.name === 'access.md') continue;
    if (entry.name === HEXIS_TOOLS_DIR.split('/')[0]) continue;

    const abs = path.join(pluginDir, entry.name);

    // A skill is a folder carrying SKILL.md — the same rule the catalog uses.
    if (entry.isDirectory() && (await exists(path.join(abs, 'SKILL.md')))) {
      const dest = path.join(pluginDir, PLUGIN_SKILLS_DIR, entry.name);
      if (await moveIfAbsent(abs, dest)) {
        notes.push(`${folderName}: ${entry.name}/ → ${PLUGIN_SKILLS_DIR}/${entry.name}/`);
      }
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.tool')) {
      // Parse BEFORE moving: a manual that will not parse still moves (it is
      // the user's file and the catalog already skips it), it just cannot be
      // projected into mcp.json.
      try {
        const content = await fs.readFile(abs, 'utf-8');
        const descriptor = normalizeToolManual(
          entry.name.replace(/\.tool$/i, ''),
          `${PLUGINS_DIR}/${folderName}/${entry.name}`,
          content,
        );
        if (descriptor.type === 'mcp' && descriptor.url) {
          mcpServers.push({
            name: descriptor.name,
            url: descriptor.url,
            headers: descriptor.headers,
          });
        }
      } catch {
        notes.push(`${folderName}: ${entry.name} did not parse — moved without an mcp.json entry`);
      }
      const dest = path.join(pluginDir, ...HEXIS_TOOLS_DIR.split('/'), entry.name);
      if (await moveIfAbsent(abs, dest)) {
        notes.push(`${folderName}: ${entry.name} → ${HEXIS_TOOLS_DIR}/${entry.name}`);
      }
    }
  }

  // Written only when there is something to say and nothing there already: a
  // hand-edited mcp.json is a deliberate act, and this migration is not the
  // place to overrule it.
  if (mcpServers.length > 0 && !(await exists(path.join(pluginDir, PLUGIN_MCP_FILE)))) {
    await fs.writeFile(path.join(pluginDir, PLUGIN_MCP_FILE), renderMcpJson(mcpServers), 'utf8');
    notes.push(`${folderName}: wrote ${PLUGIN_MCP_FILE} (${mcpServers.length} server(s))`);
  }

  return notes;
}

/**
 * Migrate `repoDir` in place. Safe to call on every top-up.
 *
 * Returns `migrated: false` when there was nothing to do — which is the steady
 * state, so the caller commits nothing.
 */
export async function migrateGroupsToPlugins(repoDir: string): Promise<PluginsMigrationResult> {
  const legacyDir = path.join(repoDir, LEGACY_GROUPS_DIR);
  const pluginsDir = path.join(repoDir, PLUGINS_DIR);
  const notes: string[] = [];

  const hasLegacy = await isDir(legacyDir);
  const hasPlugins = await isDir(pluginsDir);

  if (hasLegacy && hasPlugins) {
    // Both present: somebody is mid-migration by hand, or two branches merged
    // badly. Merging them here would guess at which copy of a same-named
    // plugin wins, so we refuse and say so — loudly, because the KB is in a
    // state a human needs to look at.
    console.warn(
      `[plugins-migration] both ${LEGACY_GROUPS_DIR}/ and ${PLUGINS_DIR}/ exist — leaving both alone. ` +
        `Merge ${LEGACY_GROUPS_DIR}/ into ${PLUGINS_DIR}/ by hand; nothing is being migrated automatically.`,
    );
    return { migrated: false, notes };
  }

  if (hasLegacy) {
    await fs.rename(legacyDir, pluginsDir);
    notes.push(`${LEGACY_GROUPS_DIR}/ → ${PLUGINS_DIR}/`);
  } else if (!hasPlugins) {
    return { migrated: false, notes };
  }

  // Runs whether or not the rename just happened, so a KB already on
  // `Plugins/` still gets missing manifests and any half-done reorganisation
  // finished. That is what makes this idempotent rather than once-only.
  for (const entry of await fs.readdir(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    notes.push(...(await migratePluginFolder(path.join(pluginsDir, entry.name), entry.name)));
  }

  return { migrated: notes.length > 0, notes };
}
