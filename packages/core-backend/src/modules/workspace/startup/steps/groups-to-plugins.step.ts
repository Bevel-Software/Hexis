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
  SKILL_DOC_FILE,
  renderPluginManifest,
} from '@bevel-software/platform-shared';
import type { ToolManualDescriptor } from '../../../tool-manuals/tool-manuals.contract.js';
import { normalizeToolManual } from '../../../tool-manuals/tool-manuals.service.js';
import { parseOwnAccessEntries } from '../../../access-model/access-grammar.js';
import { containsVariableReference } from '../../../../shared/variable-refs.js';
import { IGNORE_FILENAME } from '../../bevel-ignore.js';
import type { KbBranch, OnServerStart, ServerStartContext, StepResult } from '../on-server-start.js';

/**
 * One-way migration of a knowledge base from `Groups/` to the Agent Plugins
 * layout under `Plugins/` (https://agent-plugins.org, v1.0.0), as an
 * {@link OnServerStart} step. (It began life as an in-place module run from
 * the lazy top-up; that path is gone, and this is the only form.) Steps
 * never write: every change is DECLARED on the branch handle
 * (`move`/`write`/`remove`) and the runner applies it, while every read goes
 * against the real, pre-step tree via `repoDir()`.
 *
 * Idempotent: a KB already on the new layout is untouched, and a half-finished
 * run is completed by the next one.
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
 *
 * Scope: EVERY branch, drafts included and writable (`ctx.allBranches()`) —
 * maintenance applied uniformly at the quiet moment is what keeps a draft's
 * change-request diff down to the user's own changes; a stale draft against a
 * migrated target would diff by the whole rename.
 *
 * Outcomes: a per-manual NOT-converted refusal makes the step `partial` with
 * the reasons (the declared ops for everything else still apply); a branch
 * carrying BOTH roots contributes nothing but a note; everything else is `ok`.
 */
export class GroupsToPluginsStep implements OnServerStart {
  readonly name = 'groups-to-plugins';

  async run(ctx: ServerStartContext): Promise<StepResult> {
    const refusals: string[] = [];
    for (const branch of await ctx.allBranches()) {
      await migrateBranch(branch, refusals);
    }
    return refusals.length > 0 ? { outcome: 'partial', reason: refusals.join('; ') } : { outcome: 'ok' };
  }
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

interface ConvertedManual {
  manual: ToolManualDescriptor;
  /** Repo-relative path of the source `.tool`, removed only once the fold has been declared. */
  rel: string;
  note: string;
}

/**
 * Migrate one branch. Declares ops only; a branch whose migration declares
 * nothing stays clean, so a notes-only pass (advisory refusals) commits
 * nothing — the same contract the in-place migration's `migrated` flag
 * carried.
 */
async function migrateBranch(branch: KbBranch, refusals: string[]): Promise<void> {
  const repoDir = await branch.repoDir();
  const legacyDir = path.join(repoDir, LEGACY_GROUPS_DIR);
  const pluginsDir = path.join(repoDir, PLUGINS_DIR);

  const hasLegacy = await isDir(legacyDir);
  const hasPlugins = await isDir(pluginsDir);

  // `hasPlugins` is false for a FILE or SYMLINK squatting the `Plugins` name.
  // Checked BEFORE the nothing-to-do early return below: a branch with a
  // squatter and NO Groups/ would otherwise be silently skipped (and on a
  // draft nothing later ever reports it), while a branch mid-migration would
  // die in the applier with a bare ENOTDIR. Throw the actionable version
  // either way: under the phase's fail-closed contract this stops the boot,
  // which a squatted reserved root deserves (same stance as
  // template-files.step.ts's reserved-dir check).
  if (!hasPlugins && (await exists(pluginsDir))) {
    throw new Error(
      `Branch "${branch.name}": "${PLUGINS_DIR}" exists but is not a directory` +
        (hasLegacy ? `, so ${LEGACY_GROUPS_DIR}/ cannot be renamed to ${PLUGINS_DIR}/` : '') +
        `. Remove or rename the "${PLUGINS_DIR}" entry — the platform requires this name to be a folder.`,
    );
  }

  if (hasLegacy && hasPlugins) {
    // Both present: somebody is mid-migration by hand, or two branches merged
    // badly. Merging them here would guess at which copy of a same-named
    // plugin wins, so we refuse and say so — loudly, because the KB is in a
    // state a human needs to look at. The branch contributes no ops, only a
    // note (which surfaces in a commit only if a later step dirties it).
    console.warn(
      `[groups-to-plugins] ${branch.name}: both ${LEGACY_GROUPS_DIR}/ and ${PLUGINS_DIR}/ exist — leaving both alone. ` +
        `Merge ${LEGACY_GROUPS_DIR}/ into ${PLUGINS_DIR}/ by hand; nothing is being migrated automatically.`,
    );
    branch.note(
      `${LEGACY_GROUPS_DIR}/ and ${PLUGINS_DIR}/ both exist — merge by hand; nothing was migrated automatically`,
    );
    return;
  }
  if (!hasLegacy && !hasPlugins) return;

  // Every read below goes against the PRE-STEP tree: when the root rename is
  // declared this run it is NOT yet on disk, so the plugin folders are still
  // read under their legacy root while every declared op speaks post-rename
  // `Plugins/…` paths — the root move is declared FIRST, so by the time the
  // per-folder ops apply, the tree is already under `Plugins/`.
  const rootOnDisk = hasLegacy ? legacyDir : pluginsDir;
  // Detail notes are held back until we know ops were declared: the subject
  // line must describe a commit that will actually exist.
  const details: string[] = [];
  let changed = false;

  if (hasLegacy) {
    // The Groups→Plugins root rename is ONE declared op, directory and all.
    branch.move(LEGACY_GROUPS_DIR, PLUGINS_DIR);
    details.push(`${LEGACY_GROUPS_DIR}/ → ${PLUGINS_DIR}/`);
    changed = true;
    // Rides WITH the rename, not on every run: the rename is what turned the
    // ignore rule stale, so the run that renames is the run that heals it.
    changed = (await rewriteIgnoreRootRule(repoDir, branch, details)) || changed;
  }

  // Runs whether or not the rename just happened, so a KB already on
  // `Plugins/` still gets missing manifests and any half-done reorganisation
  // finished. That is what makes this idempotent rather than once-only.
  for (const entry of await fs.readdir(rootOnDisk, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folderChanged = await migratePluginFolder(
      branch,
      path.join(rootOnDisk, entry.name),
      entry.name,
      details,
      refusals,
    );
    changed = changed || folderChanged;
  }

  if (!changed) return;
  // First note becomes the commit subject — the same messages the lazy
  // top-up committed under; the detail notes become its body.
  branch.note(
    hasLegacy
      ? `Move ${LEGACY_GROUPS_DIR}/ to ${PLUGINS_DIR}/ (Agent Plugins layout)`
      : `Reorganise ${PLUGINS_DIR}/ to the Agent Plugins layout`,
  );
  for (const line of details) branch.note(line);
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
async function rewriteIgnoreRootRule(repoDir: string, branch: KbBranch, details: string[]): Promise<boolean> {
  let current: string;
  try {
    current = await fs.readFile(path.join(repoDir, IGNORE_FILENAME), 'utf-8');
  } catch {
    return false; // no ignore file — nothing went stale
  }
  const legacyRule = `${LEGACY_GROUPS_DIR}/`;
  const newRule = `${PLUGINS_DIR}/`;
  const lines = current.split('\n');
  if (lines.some((l) => l.trim() === newRule)) return false;
  const idx = lines.findIndex((l) => l.trim() === legacyRule);
  if (idx === -1) return false;
  // EVERY exact-match line follows the rename: the first becomes the new
  // rule, any further duplicates are dropped — rewriting only the first would
  // leave stale `Groups/` lines behind, and the already-has-Plugins guard
  // above means a second pass would never touch them.
  lines[idx] = newRule;
  const rewritten = lines.filter((l, i) => i <= idx || l.trim() !== legacyRule);
  branch.write(IGNORE_FILENAME, rewritten.join('\n'));
  details.push(`${IGNORE_FILENAME}: ${legacyRule} → ${newRule}`);
  return true;
}

/**
 * Reorganise ONE plugin folder. `folderDir` is where the folder sits ON DISK
 * (under the legacy root when the rename is buffered this run); declared op
 * paths always speak `Plugins/<folder>/…`. Returns whether ops were declared.
 */
async function migratePluginFolder(
  branch: KbBranch,
  folderDir: string,
  folderName: string,
  details: string[],
  refusals: string[],
): Promise<boolean> {
  const relPlugin = `${PLUGINS_DIR}/${folderName}`;
  let changed = false;

  // When the manifest is written this run its content is remembered: the
  // buffered write is not on disk yet, and the fold below must see it.
  let renderedManifest: string | null = null;
  if (!(await exists(path.join(folderDir, PLUGIN_MANIFEST_FILE)))) {
    renderedManifest = renderPluginManifest(folderName);
    branch.write(`${relPlugin}/${PLUGIN_MANIFEST_FILE}`, renderedManifest);
    details.push(`${folderName}: wrote ${PLUGIN_MANIFEST_FILE}`);
    changed = true;
  }

  const entries = await fs.readdir(folderDir, { withFileTypes: true });
  const converted: ConvertedManual[] = [];

  const convertOrMove = async (abs: string, rel: string, note: string): Promise<void> => {
    const manual = await asMcpManual(abs, rel);
    if (manual !== null && typeof manual !== 'string') {
      // QUEUED for conversion — the `.tool`'s removal is declared only AFTER
      // its entry's writes (see foldIntoPluginFiles). Buffering makes the
      // apply all-or-nothing anyway, but the declaration order keeps the old
      // recovery reasoning legible: the file IS the recovery path until the
      // fold has landed.
      converted.push({ manual, rel, note });
      return;
    }
    if (typeof manual === 'string') {
      // The operator's answer to "why is this integration not in mcp.json":
      // a refused conversion must read as the deliberate retention it is —
      // surfaced through the step's `partial` reason rather than a note, so
      // it names what did NOT change instead of decorating a commit.
      refusals.push(`${branch.name}: ${folderName}: ${note} NOT converted — ${manual}; kept as a .tool`);
    }
    const destDisk = path.join(folderDir, ...HEXIS_TOOLS_DIR.split('/'), path.basename(abs));
    // Never overwrite: a destination that already exists means a previous run
    // got there first (or a human did), and clobbering it would destroy the
    // newer copy. The check is against the pre-step tree — the only tree that
    // exists while this step runs.
    if (abs !== destDisk && !(await exists(destDisk))) {
      branch.move(rel, `${relPlugin}/${HEXIS_TOOLS_DIR}/${path.basename(abs)}`);
      details.push(`${folderName}: ${note} → ${HEXIS_TOOLS_DIR}/${path.basename(abs)}`);
      changed = true;
    }
  };

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === PLUGIN_SKILLS_DIR || entry.name === PLUGIN_MANIFEST_FILE) continue;
    if (entry.name === PLUGIN_MCP_FILE || entry.name === 'access.md') continue;
    if (entry.name === HEXIS_TOOLS_DIR.split('/')[0]) continue;

    const abs = path.join(folderDir, entry.name);

    // A skill is a folder carrying SKILL.md — the same rule the catalog uses.
    if (entry.isDirectory() && (await exists(path.join(abs, SKILL_DOC_FILE)))) {
      if (!(await exists(path.join(folderDir, PLUGIN_SKILLS_DIR, entry.name)))) {
        branch.move(`${relPlugin}/${entry.name}`, `${relPlugin}/${PLUGIN_SKILLS_DIR}/${entry.name}`);
        details.push(`${folderName}: ${entry.name}/ → ${PLUGIN_SKILLS_DIR}/${entry.name}/`);
        changed = true;
      }
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.tool')) {
      await convertOrMove(abs, `${relPlugin}/${entry.name}`, entry.name);
    }
  }

  // Second sweep: mcp `.tool`s an EARLIER run moved into the extension dir
  // (when mcp.json was a projection, not the authority). Converting them here
  // is what makes the migration complete itself rather than strand a twin.
  // `isDir` is lstat-based, so a SYMLINK planted at this path is not swept:
  // this sweep DELETES what it converts, and following a link would delete
  // `.tool` files from wherever the link really points.
  //
  // Under buffered ops this sweep reads the PRE-STEP tree, so a `.tool` the
  // first sweep just declared moved here is not visible — and does not need
  // to be: same-run movables were already converted or refused by the same
  // `asMcpManual` logic above. The sweep exists for files parked by EARLIER
  // runs, which are on disk. (The old in-place code happened to re-see
  // same-run moves and no-op on them; the buffered read makes that a
  // non-event by construction.)
  const extToolsDir = path.join(folderDir, ...HEXIS_TOOLS_DIR.split('/'));
  if (await isDir(extToolsDir)) {
    for (const entry of await fs.readdir(extToolsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.tool')) continue;
      const abs = path.join(extToolsDir, entry.name);
      const rel = `${relPlugin}/${HEXIS_TOOLS_DIR}/${entry.name}`;
      const manual = await asMcpManual(abs, rel);
      // A refusal reason here is a SETTLED resident of the tools dir — it
      // was named the run it moved in, and this sweep repeats every boot,
      // so re-raising it would be log spam. Only a convertible manual queues.
      if (manual !== null && typeof manual !== 'string') {
        converted.push({ manual, rel, note: `${HEXIS_TOOLS_DIR}/${entry.name}` });
      }
    }
  }

  changed =
    (await foldIntoPluginFiles(branch, folderDir, relPlugin, folderName, renderedManifest, converted, details, refusals)) ||
    changed;
  return changed;
}

/**
 * Fold converted mcp manuals into the plugin's mcp.json and plugin.json.
 *
 * MERGE, never clobber: an entry already present under a manual's key — hand
 * written or from a previous run — wins, because overwriting it would discard
 * the newer intent. The extension block merges the same way. A plugin.json
 * that does not parse costs the extension write (logged), not the migration.
 */
async function foldIntoPluginFiles(
  branch: KbBranch,
  folderDir: string,
  relPlugin: string,
  folderName: string,
  renderedManifest: string | null,
  manuals: ConvertedManual[],
  details: string[],
  refusals: string[],
): Promise<boolean> {
  if (manuals.length === 0) return false;

  const mcp = (await readJson(path.join(folderDir, PLUGIN_MCP_FILE))) ?? {
    $schema: PLUGIN_MCP_SCHEMA,
    mcpServers: {},
  };
  // An array (or any non-object) here would take property assignments and then
  // drop them at stringify — normalize to an object before merging into it.
  if (typeof mcp.mcpServers !== 'object' || mcp.mcpServers === null || Array.isArray(mcp.mcpServers)) {
    mcp.mcpServers = {};
  }
  const servers = mcp.mcpServers as Record<string, unknown>;

  // The manifest may have been DECLARED this very run — a buffered write not
  // yet on disk. Reading the disk then would see "missing" and refuse
  // conversions the write-then-read in-place code performed, so the step's
  // own rendered content stands in for the tree it is about to produce.
  const manifest =
    renderedManifest !== null
      ? (JSON.parse(renderedManifest) as Record<string, unknown>)
      : await readJson(path.join(folderDir, PLUGIN_MANIFEST_FILE));
  if (manifest === null) {
    console.warn(
      `[groups-to-plugins] ${branch.name}: ${folderName}/${PLUGIN_MANIFEST_FILE} is missing or unparsable — ` +
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
    const extEntry = {
      ...(Object.keys(credential).length > 0 ? { headers: credential } : {}),
      ...(m.variables && m.variables.length > 0 ? { variables: m.variables } : {}),
      ...(typeof m.description === 'string' ? { description: m.description } : {}),
      ...(m.remote === false ? { local: true } : {}),
    };
    if (manifest === null && Object.keys(extEntry).length > 0) {
      refusals.push(
        `${branch.name}: ${folderName}: ${item.note} NOT converted — ${PLUGIN_MANIFEST_FILE} is missing/unparsable ` +
          'and the manual carries declarations (auth headers, variables, a description, or the ' +
          'local-only flag) that would be lost; fix the manifest first',
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
      details.push(`${folderName}: ${m.name} → ${PLUGIN_MCP_FILE}`);
    }

    // The non-portable half: auth headers, variable declarations, local-only.
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

  if (wroteMcp) {
    branch.write(`${relPlugin}/${PLUGIN_MCP_FILE}`, `${JSON.stringify(mcp, null, 2)}\n`);
  }
  if (wroteManifest) {
    // May supersede the bare manifest declared above — ops apply in order, so
    // the extended content is what lands.
    branch.write(`${relPlugin}/${PLUGIN_MANIFEST_FILE}`, `${JSON.stringify(manifest, null, 2)}\n`);
    details.push(`${folderName}: wrote mcp-server declarations into ${PLUGIN_MANIFEST_FILE}`);
  }
  // Sources go LAST in declaration order, once everything they carried has
  // been declared elsewhere — the same shape the in-place code used so a
  // failure never stranded the non-portable half with no source to retry from.
  for (const item of folded) {
    branch.remove(item.rel);
    details.push(`${folderName}: ${item.note} converted to an ${PLUGIN_MCP_FILE} entry`);
  }
  return wroteMcp || wroteManifest || folded.length > 0;
}
