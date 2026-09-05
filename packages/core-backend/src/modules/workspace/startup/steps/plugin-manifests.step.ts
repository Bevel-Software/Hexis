import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HEXIS_EXTENSION_NS,
  PLUGINS_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  PLUGIN_SKILLS_DIR,
  renderPluginManifest,
} from '@bevel-software/platform-shared';
import { BUNDLE_FILE } from '../../../plugins/discovery/bundle-dialect/bundle.source.js';
import type { KbBranch, OnServerStart, ServerStartContext, StepResult } from '../on-server-start.js';

/**
 * Give every legacy plugin folder its manifest, as an {@link OnServerStart}
 * step.
 *
 * A plugin IS a folder carrying `plugin.json` (or a `plugin.bundle.json`, the
 * read-only customer dialect) — discovery reads nothing else, at any depth.
 * Folders from before the manifest existed have `access.md`, an `mcp.json`,
 * a `skills/` tree or `.tool` manuals and no `plugin.json` beside them; the
 * old scanners read those by position (directly under the plugins root),
 * and this step is what retires that rule: it writes the minimal manifest
 * into each such folder, once, so the position never has to mean anything
 * again.
 *
 * WHICH folders: walk the plugins root; a folder holding either file is a
 * plugin and is not entered. Any other folder is entered first. A folder
 * DIRECTLY under the root — the only place the legacy layout ever put a
 * plugin — becomes one when nothing plugin-shaped lives beneath it and its
 * own content is legacy content: a scope folder (the dialect's
 * `plugins/functional/…`) can carry an `access.md` of its own and must stay
 * a scope, and a skill folder inside a legacy plugin must not become a
 * plugin of its own. "Legacy content" is the set of things provisioning and
 * the old migration ever put in a plugin folder: `access.md`, `mcp.json`,
 * `skills/`, the hexis extension directory, a `.tool` file, or a `SKILL.md`
 * anywhere beneath (the pre-`skills/` shape).
 *
 * Every branch, drafts included, like the Groups→Plugins migration and for
 * the same reason: a draft migrated alongside its target diffs by the user's
 * own changes only. Idempotent: a folder that has its manifest is skipped.
 */
export class PluginManifestsStep implements OnServerStart {
  readonly name = 'plugin-manifests';

  async run(ctx: ServerStartContext): Promise<StepResult> {
    for (const branch of await ctx.allBranches()) {
      await addManifests(branch);
    }
    return { outcome: 'ok' };
  }
}

async function addManifests(branch: KbBranch): Promise<void> {
  const repoDir = await branch.repoDir();
  const root = path.join(repoDir, PLUGINS_DIR);
  const added: string[] = [];

  /** Resolves to how many plugins sit at or beneath `dir`. */
  const visit = async (dir: string, rel: string): Promise<number> => {
    if (rel && ((await isFile(path.join(dir, PLUGIN_MANIFEST_FILE))) || (await isFile(path.join(dir, BUNDLE_FILE))))) {
      return 1;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Absence is the plugins root not existing yet; anything else must stop
      // the boot rather than quietly leave legacy plugins without manifests.
      if (isAbsence(err)) return 0;
      throw err;
    }
    let beneath = 0;
    for (const entry of entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))) {
      beneath += await visit(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
    }
    if (beneath > 0 || !rel || rel.includes('/')) return beneath;
    if (!(await looksLikeLegacyPlugin(dir, entries))) return 0;
    const manifestRel = `${PLUGINS_DIR}/${rel}/${PLUGIN_MANIFEST_FILE}`;
    branch.write(manifestRel, renderPluginManifest(path.posix.basename(rel)));
    added.push(rel);
    return 1;
  };

  await visit(root, '');
  if (added.length === 0) return;
  branch.note(`Add plugin manifests to ${added.length === 1 ? 'a legacy plugin folder' : `${added.length} legacy plugin folders`}`);
  for (const rel of added) branch.note(`${PLUGINS_DIR}/${rel}: ${PLUGIN_MANIFEST_FILE} written`);
}

async function looksLikeLegacyPlugin(dir: string, entries: import('node:fs').Dirent[]): Promise<boolean> {
  for (const entry of entries) {
    if (entry.isFile() && (entry.name === 'access.md' || entry.name === PLUGIN_MCP_FILE || entry.name.toLowerCase().endsWith('.tool'))) {
      return true;
    }
    if (entry.isDirectory() && (entry.name === PLUGIN_SKILLS_DIR || entry.name === HEXIS_EXTENSION_NS)) return true;
  }
  return hasSkillBeneath(dir);
}

/** The pre-`skills/` shape: `Plugins/<Plugin>/<skill>/SKILL.md`, at any depth. */
async function hasSkillBeneath(dir: string): Promise<boolean> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isAbsence(err)) return false;
    throw err;
  }
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) return true;
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && (await hasSkillBeneath(path.join(dir, entry.name)))) {
      return true;
    }
  }
  return false;
}

async function isFile(abs: string): Promise<boolean> {
  return fs.stat(abs).then(
    (s) => s.isFile(),
    (err: unknown) => {
      if (isAbsence(err)) return false;
      throw err; // a probe that fails for another reason is not "no manifest"
    },
  );
}

function isAbsence(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
