import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HEXIS_EXTENSION_NS,
  HEXIS_TOOLS_DIR,
  LEGACY_GROUPS_DIR,
  PLUGINS_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  PLUGIN_MCP_SCHEMA,
  PLUGIN_SKILLS_DIR,
  renderPluginManifest,
} from '@bevel-software/platform-shared';
import type { ToolManualDescriptor } from '../tool-manuals/tool-manuals.contract.js';
import { normalizeToolManual } from '../tool-manuals/tool-manuals.service.js';

/**
 * One-way migration of a knowledge base from `Groups/` to the Agent Plugins
 * layout under `Plugins/` (https://agent-plugins.org, v1.0.0).
 *
 * Runs from the seed top-up, so every deployment self-heals on the next load of
 * a protected branch. Idempotent: a KB already on the new layout is untouched,
 * and a half-finished run is completed by the next one.
 *
 * What moves — and what CONVERTS:
 *
 *   Groups/GTM/access.md            → Plugins/GTM/access.md            (stays put)
 *   Groups/GTM/deploy/SKILL.md      → Plugins/GTM/skills/deploy/SKILL.md
 *   Groups/GTM/web-search.tool      → Plugins/GTM/software.bevel.hexis/tools/web-search.tool
 *   Groups/GTM/notion.tool (mcp)    → an entry in Plugins/GTM/mcp.json, and the
 *                                     `.tool` file is DELETED — mcp.json is
 *                                     authoritative for MCP servers now.
 *                                     Plugins/GTM/plugin.json           (written)
 *
 * The mcp.json entry is keyed by the `.tool`'s manual id: that id is the
 * namespace vault secrets bind to (`<id>_<VAR>`), so keeping it is what keeps
 * every configured secret and completed OAuth grant bound. What mcp.json
 * cannot carry — auth headers with `${VAR}` references, variable declarations,
 * the local-only flag — moves into `plugin.json`'s
 * `extensions["software.bevel.hexis"].mcpServers[<id>]` block, the reverse-DNS
 * namespace the spec reserves for client-specific data. `http`/`inline`
 * manuals still MOVE as `.tool` files: nothing but this platform can run them.
 */

export interface PluginsMigrationResult {
  migrated: boolean;
  /** Whether the `Groups/` → `Plugins/` root rename itself happened this run. */
  renamed: boolean;
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

/** A header value referencing a vault variable rather than carrying a literal. */
function isCredentialReference(value: string): boolean {
  return /\$\{[^}]+\}/.test(value);
}

/** Split a manual's headers into what mcp.json may carry and what may not. */
function splitHeaders(headers: Record<string, string> | undefined): {
  literal: Record<string, string>;
  credential: Record<string, string>;
} {
  const literal: Record<string, string> = {};
  const credential: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    (isCredentialReference(v) ? credential : literal)[k] = v;
  }
  return { literal, credential };
}

/** Read+parse a JSON file, or `null` when absent or unparsable. */
async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(p, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Fold converted mcp manuals into the plugin's mcp.json and plugin.json.
 *
 * MERGE, never clobber: an entry already present under a manual's key — hand
 * written or from a previous run — wins, because overwriting it would discard
 * the newer intent. The extension block merges the same way. A plugin.json
 * that does not parse costs the extension write (logged), not the migration.
 */
interface ConvertedManual {
  manual: ToolManualDescriptor;
  /** The source `.tool`, deleted only once the fold has landed. */
  abs: string;
  note: string;
}

async function foldIntoPluginFiles(
  pluginDir: string,
  folderName: string,
  manuals: ConvertedManual[],
  notes: string[],
): Promise<void> {
  if (manuals.length === 0) return;

  const mcpPath = path.join(pluginDir, PLUGIN_MCP_FILE);
  const mcp = (await readJson(mcpPath)) ?? { $schema: PLUGIN_MCP_SCHEMA, mcpServers: {} };
  // An array (or any non-object) here would take property assignments and then
  // drop them at stringify — normalize to an object before merging into it.
  if (typeof mcp.mcpServers !== 'object' || mcp.mcpServers === null || Array.isArray(mcp.mcpServers)) {
    mcp.mcpServers = {};
  }
  const servers = mcp.mcpServers as Record<string, unknown>;

  const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST_FILE);
  const manifest = await readJson(manifestPath);
  if (manifest === null) {
    console.warn(
      `[plugins-migration] ${folderName}/${PLUGIN_MANIFEST_FILE} is missing or unparsable — ` +
        'mcp manuals convert only when they carry NOTHING for the extensions block; any ' +
        'non-portable half (auth headers, variables, a description, or the local-only flag) ' +
        'keeps the manual a `.tool` until the manifest is fixed.',
    );
  }

  let wroteMcp = false;
  let wroteManifest = false;
  const folded: ConvertedManual[] = [];
  for (const item of manuals.sort((a, b) => a.manual.name.localeCompare(b.manual.name))) {
    const m = item.manual;
    const { literal, credential } = splitHeaders(m.headers);
    // A manual whose non-portable half (auth headers, variables, local flag)
    // has nowhere to go — the manifest is missing or unparsable — is NOT
    // converted at all: writing only its portable half and deleting the
    // source would silently discard the credential wiring. It stays a
    // `.tool` until the manifest is fixed.
    const extEntryPreview = {
      ...(Object.keys(credential).length > 0 ? { headers: credential } : {}),
      ...(m.variables && m.variables.length > 0 ? { variables: m.variables } : {}),
      ...(typeof m.description === 'string' ? { description: m.description } : {}),
      ...(m.remote === false ? { local: true } : {}),
    };
    if (manifest === null && Object.keys(extEntryPreview).length > 0) {
      notes.push(
        `${folderName}: ${item.note} NOT converted — ${PLUGIN_MANIFEST_FILE} is missing/unparsable ` +
          'and the manual carries declarations (auth headers, variables, a description, or the ' +
          'local-only flag) that would be lost; fix the manifest first.',
      );
      continue;
    }
    folded.push(item);
    // Own-property check: `in` sees `constructor` and friends on the prototype,
    // which would silently skip a legitimately named server.
    if (!Object.prototype.hasOwnProperty.call(servers, m.name)) {
      servers[m.name] = {
        type: 'streamable-http',
        url: m.url,
        ...(Object.keys(literal).length > 0 ? { headers: literal } : {}),
      };
      wroteMcp = true;
      notes.push(`${folderName}: ${m.name} → ${PLUGIN_MCP_FILE}`);
    }

    // The non-portable half: auth headers, variable declarations, local-only.
    const extEntry = extEntryPreview;
    if (manifest !== null && Object.keys(extEntry).length > 0) {
      // Normalize each level: a parseable manifest can still carry a string or
      // array where an object belongs, and mutating that would throw mid-run.
      if (typeof manifest.extensions !== 'object' || manifest.extensions === null || Array.isArray(manifest.extensions)) {
        manifest.extensions = {};
      }
      const ext = manifest.extensions as Record<string, unknown>;
      if (typeof ext[HEXIS_EXTENSION_NS] !== 'object' || ext[HEXIS_EXTENSION_NS] === null || Array.isArray(ext[HEXIS_EXTENSION_NS])) {
        ext[HEXIS_EXTENSION_NS] = {};
      }
      const ns = ext[HEXIS_EXTENSION_NS] as Record<string, unknown>;
      if (typeof ns.mcpServers !== 'object' || ns.mcpServers === null || Array.isArray(ns.mcpServers)) {
        ns.mcpServers = {};
      }
      const extServers = ns.mcpServers as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(extServers, m.name)) {
        extServers[m.name] = extEntry;
        wroteManifest = true;
      }
    }
  }

  if (wroteMcp) await fs.writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, 'utf8');
  if (wroteManifest) {
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    notes.push(`${folderName}: wrote mcp-server declarations into ${PLUGIN_MANIFEST_FILE}`);
  }
  // Sources go LAST, once everything they carried is on disk elsewhere. A
  // failure anywhere above leaves every `.tool` in place for the next run —
  // which re-converts idempotently, since the fold never clobbers a key.
  for (const item of folded) {
    await fs.rm(item.abs, { force: true });
    notes.push(`${folderName}: ${item.note} converted to an ${PLUGIN_MCP_FILE} entry`);
  }
}

/**
 * Parse a `.tool`; a convertible MCP manual (has a url) parses to a
 * descriptor, anything else — other types, or a file that will not parse —
 * to `null` and is left as a `.tool`.
 */
async function asMcpManual(abs: string, repoRel: string): Promise<ToolManualDescriptor | null> {
  try {
    const content = await fs.readFile(abs, 'utf-8');
    const d = normalizeToolManual(path.basename(abs).replace(/\.tool$/i, ''), repoRel, content);
    // The mcp.json loader accepts only names it can serve as a namespace and
    // route slug — converting a manual whose id fails that shape would DELETE
    // a working integration and write an entry discovery then skips. Such a
    // manual stays a `.tool`.
    if (d.type !== 'mcp' || !d.url) return null;
    return /^[a-z0-9][a-z0-9_-]*$/.test(d.name) ? d : null;
  } catch {
    return null;
  }
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
  const converted: ConvertedManual[] = [];

  const convertOrMove = async (abs: string, name: string, note: string): Promise<void> => {
    const manual = await asMcpManual(abs, `${PLUGINS_DIR}/${folderName}/${name}`);
    if (manual) {
      // QUEUED for conversion — the `.tool` is deleted only AFTER its entry
      // has actually landed in the output files (see foldIntoPluginFiles).
      // Deleting first left a window where a failed fold stranded the
      // non-portable half (auth headers, variables) with no source to retry
      // from: the file IS the recovery path until the fold succeeds.
      converted.push({ manual, abs, note });
      return;
    }
    const dest = path.join(pluginDir, ...HEXIS_TOOLS_DIR.split('/'), path.basename(abs));
    if (abs !== dest && (await moveIfAbsent(abs, dest))) {
      notes.push(`${folderName}: ${note} → ${HEXIS_TOOLS_DIR}/${path.basename(abs)}`);
    }
  };

  for (const entry of entries) {
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
      await convertOrMove(abs, entry.name, entry.name);
    }
  }

  // Second sweep: mcp `.tool`s an EARLIER run moved into the extension dir
  // (when mcp.json was a projection, not the authority). Converting them here
  // is what makes the migration complete itself rather than strand a twin.
  const extToolsDir = path.join(pluginDir, ...HEXIS_TOOLS_DIR.split('/'));
  if (await isDir(extToolsDir)) {
    for (const entry of await fs.readdir(extToolsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.tool')) continue;
      const abs = path.join(extToolsDir, entry.name);
      const manual = await asMcpManual(abs, `${PLUGINS_DIR}/${folderName}/${HEXIS_TOOLS_DIR}/${entry.name}`);
      if (manual) converted.push({ manual, abs, note: `${HEXIS_TOOLS_DIR}/${entry.name}` });
    }
  }

  await foldIntoPluginFiles(pluginDir, folderName, converted, notes);
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
    return { migrated: false, renamed: false, notes };
  }

  let renamed = false;
  if (hasLegacy) {
    await fs.rename(legacyDir, pluginsDir);
    renamed = true;
    notes.push(`${LEGACY_GROUPS_DIR}/ → ${PLUGINS_DIR}/`);
  } else if (!hasPlugins) {
    return { migrated: false, renamed: false, notes };
  }

  // Runs whether or not the rename just happened, so a KB already on
  // `Plugins/` still gets missing manifests and any half-done reorganisation
  // finished. That is what makes this idempotent rather than once-only.
  for (const entry of await fs.readdir(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    notes.push(...(await migratePluginFolder(path.join(pluginsDir, entry.name), entry.name)));
  }

  return { migrated: notes.length > 0, renamed, notes };
}
