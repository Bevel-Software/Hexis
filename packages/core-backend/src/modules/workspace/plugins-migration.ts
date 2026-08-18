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
import { parseOwnAccessEntries } from '../access/access-control.service.js';
import { containsVariableReference } from '../../shared/variable-refs.js';
import { IGNORE_FILENAME } from './bevel-ignore.js';

// SUPERSEDED by startup/steps/groups-to-plugins.step.ts (the buffered OnServerStart
// form); this in-place module stays only while kb-seed's lazy path lives, and is
// removed with it.
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
  /**
   * Whether this run CHANGED FILES. Notes alone (a manual that could not be
   * converted, say) do not set it — the caller stages and commits on this
   * flag, and a note-only run has nothing to commit.
   */
  migrated: boolean;
  /** Whether the `Groups/` → `Plugins/` root rename itself happened this run. */
  renamed: boolean;
  /** Whether the KB's own `.bevelignore` had its `Groups/` rule rewritten (a repo-root file, staged separately). */
  ignoreRewritten: boolean;
  /** Human-readable summary lines (plugin names, tool moves) for the seed log. */
  notes: string[];
}

// lstat, both helpers: SYMLINKS ARE NOT SUPPORTED IN PLUGINS, anywhere, so a
// link never counts as the thing it points at — following one here would let
// a symlinked directory pull files from outside the plugin into the sweep
// (and delete them from wherever they really live).
async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isDirectory();
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
 * A header value referencing a vault variable rather than carrying a literal.
 * The substitutor's own grammar decides (shared/variable-refs.ts): both
 * spellings it expands — `${VAR}` and bare `$VAR`, digit-leading names
 * included — count, because either one copied into mcp.json would be
 * transmitted verbatim by a conformant client. That means a prose `$5` in a
 * header routes to the non-portable half too: over-classifying costs a header
 * its portability, under-classifying leaks whatever `$5TOKEN` expands to.
 */
const isCredentialReference = containsVariableReference;

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
): Promise<boolean> {
  if (manuals.length === 0) return false;

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
  return wroteMcp || wroteManifest || folded.length > 0;
}

/**
 * Parse a `.tool`; a convertible MCP manual (has a url) parses to a
 * descriptor. A non-candidate (other types, a file that will not parse)
 * is `null` and moves as a plain `.tool`; an MCP manual REFUSED conversion
 * comes back as the reason string, so the migration log distinguishes a
 * deliberately-retained integration from one that silently failed — the
 * same courtesy the manifest-missing refusal already extends.
 */
async function asMcpManual(abs: string, repoRel: string): Promise<ToolManualDescriptor | string | null> {
  try {
    const content = await fs.readFile(abs, 'utf-8');
    const d = normalizeToolManual(path.basename(abs).replace(/\.tool$/i, ''), repoRel, content);
    // The mcp.json loader accepts only names it can serve as a namespace and
    // route slug — converting a manual whose id fails that shape would DELETE
    // a working integration and write an entry discovery then skips. Such a
    // manual stays a `.tool`.
    if (d.type !== 'mcp' || !d.url) return null;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(d.name)) {
      return `its id "${d.name}" is not a valid mcp.json server name`;
    }
    // Same refusal for the url: the mcp.json loader accepts only a directly
    // parseable http(s) url, so a templated one (`${BASE}/mcp` — legal in a
    // `.tool`, where the substitutor expands it) would convert into an entry
    // discovery then skips, with the source already deleted. And a parseable
    // url carrying `user:pass@` may not land in the PORTABLE file at all —
    // stripping it would break the server, so the manual keeps its `.tool`
    // form, where the credential stays platform-internal.
    let url: URL;
    try {
      url = new URL(d.url);
    } catch {
      return 'its url is not directly parseable (a templated url only a .tool can carry)';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return `its url scheme "${url.protocol}" cannot land in mcp.json (http(s) only)`;
    }
    if (url.username || url.password) {
      return 'its url embeds credentials, which may not land in the portable mcp.json';
    }
    // A `.tool` can gate ITSELF with frontmatter access verbs, read by the
    // access resolver from the file's own path. An mcp.json entry has no
    // per-server home for those — the file's ACL governs every server in it —
    // so converting would silently widen who may configure and run the
    // server. Such a manual stays a `.tool`, verbs and all.
    if (parseOwnAccessEntries(content) !== null) {
      return 'it gates itself with frontmatter access verbs, which mcp.json cannot carry';
    }
    return d;
  } catch {
    return null;
  }
}

/** Reorganise ONE plugin folder in place. Returns notes + whether files changed. */
async function migratePluginFolder(
  pluginDir: string,
  folderName: string,
): Promise<{ notes: string[]; changed: boolean }> {
  const notes: string[] = [];
  let changed = false;

  if (!(await exists(path.join(pluginDir, PLUGIN_MANIFEST_FILE)))) {
    await fs.writeFile(
      path.join(pluginDir, PLUGIN_MANIFEST_FILE),
      renderPluginManifest(folderName),
      'utf8',
    );
    notes.push(`${folderName}: wrote ${PLUGIN_MANIFEST_FILE}`);
    changed = true;
  }

  const entries = await fs.readdir(pluginDir, { withFileTypes: true });
  const converted: ConvertedManual[] = [];

  const convertOrMove = async (abs: string, name: string, note: string): Promise<void> => {
    const manual = await asMcpManual(abs, `${PLUGINS_DIR}/${folderName}/${name}`);
    if (manual !== null && typeof manual !== 'string') {
      // QUEUED for conversion — the `.tool` is deleted only AFTER its entry
      // has actually landed in the output files (see foldIntoPluginFiles).
      // Deleting first left a window where a failed fold stranded the
      // non-portable half (auth headers, variables) with no source to retry
      // from: the file IS the recovery path until the fold succeeds.
      converted.push({ manual, abs, note });
      return;
    }
    if (typeof manual === 'string') {
      // The operator's answer to "why is this integration not in mcp.json":
      // a refused conversion must read as the deliberate retention it is.
      notes.push(`${folderName}: ${note} NOT converted — ${manual}; kept as a .tool`);
    }
    const dest = path.join(pluginDir, ...HEXIS_TOOLS_DIR.split('/'), path.basename(abs));
    if (abs !== dest && (await moveIfAbsent(abs, dest))) {
      notes.push(`${folderName}: ${note} → ${HEXIS_TOOLS_DIR}/${path.basename(abs)}`);
      changed = true;
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
        changed = true;
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
  // `isDir` is lstat-based, so a SYMLINK planted at this path is not swept:
  // this sweep DELETES what it converts, and following a link would delete
  // `.tool` files from wherever the link really points.
  const extToolsDir = path.join(pluginDir, ...HEXIS_TOOLS_DIR.split('/'));
  if (await isDir(extToolsDir)) {
    for (const entry of await fs.readdir(extToolsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.tool')) continue;
      const abs = path.join(extToolsDir, entry.name);
      const manual = await asMcpManual(abs, `${PLUGINS_DIR}/${folderName}/${HEXIS_TOOLS_DIR}/${entry.name}`);
      // A refusal reason here is a SETTLED resident of the tools dir — it
      // was named the run it moved in, and this sweep repeats every boot,
      // so re-noting it would be log spam. Only a convertible manual queues.
      if (manual !== null && typeof manual !== 'string') {
        converted.push({ manual, abs, note: `${HEXIS_TOOLS_DIR}/${entry.name}` });
      }
    }
  }

  changed = (await foldIntoPluginFiles(pluginDir, folderName, converted, notes)) || changed;
  return { notes, changed };
}

/**
 * Rewrite the KB's `.bevelignore` rule for the renamed root: the exact line
 * `Groups/` becomes `Plugins/`. Without this a migrated KB is left with a
 * stale rule for a folder that no longer exists and NO rule for the new one,
 * so plugin internals start showing up in the file tree and agent view.
 *
 * The file is the operator's — this touches ONE line, the one the platform's
 * own rename invalidated, and only when `Plugins/` is not already listed
 * (in which case the stale line is harmlessly dead and left alone).
 */
async function rewriteIgnoreRootRule(repoDir: string, notes: string[]): Promise<boolean> {
  const ignorePath = path.join(repoDir, IGNORE_FILENAME);
  let current: string;
  try {
    current = await fs.readFile(ignorePath, 'utf-8');
  } catch {
    return false; // no ignore file — nothing went stale
  }
  const legacyRule = `${LEGACY_GROUPS_DIR}/`;
  const newRule = `${PLUGINS_DIR}/`;
  const lines = current.split('\n');
  if (lines.some((l) => l.trim() === newRule)) return false;
  const idx = lines.findIndex((l) => l.trim() === legacyRule);
  if (idx === -1) return false;
  lines[idx] = newRule;
  await fs.writeFile(ignorePath, lines.join('\n'), 'utf-8');
  notes.push(`${IGNORE_FILENAME}: ${legacyRule} → ${newRule}`);
  return true;
}

/**
 * Migrate `repoDir` in place. Safe to call on every top-up.
 *
 * Returns `migrated: false` when no FILE changed — which is the steady state,
 * so the caller commits nothing. Advisory `notes` may still be present (a
 * manual that refuses to convert reports itself every run) and set nothing.
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
    return { migrated: false, renamed: false, ignoreRewritten: false, notes };
  }

  let renamed = false;
  let ignoreRewritten = false;
  if (hasLegacy) {
    await fs.rename(legacyDir, pluginsDir);
    renamed = true;
    notes.push(`${LEGACY_GROUPS_DIR}/ → ${PLUGINS_DIR}/`);
    // Rides WITH the rename, not on every run: the rename is what turned the
    // ignore rule stale, so the run that renames is the run that heals it.
    ignoreRewritten = await rewriteIgnoreRootRule(repoDir, notes);
  } else if (!hasPlugins) {
    return { migrated: false, renamed: false, ignoreRewritten: false, notes };
  }

  // Runs whether or not the rename just happened, so a KB already on
  // `Plugins/` still gets missing manifests and any half-done reorganisation
  // finished. That is what makes this idempotent rather than once-only.
  let changed = renamed || ignoreRewritten;
  for (const entry of await fs.readdir(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = await migratePluginFolder(path.join(pluginsDir, entry.name), entry.name);
    notes.push(...folder.notes);
    changed = changed || folder.changed;
  }

  return { migrated: changed, renamed, ignoreRewritten, notes };
}
