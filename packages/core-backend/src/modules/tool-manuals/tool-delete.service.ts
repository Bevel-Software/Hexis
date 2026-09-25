import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HEXIS_EXTENSION_NS,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  type AuthUser,
} from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { KbContext } from '../../shared/kb-context.js';
import { utcpNamespacePrefix } from '../../shared/utcp-namespace.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import type { IFsProbe } from '../../shared/fs.contract.js';
import type { ISkillService } from '../skills/skills.contract.js';
import type { IPluginIndexService, PluginCatalogEntry } from '../plugins/plugins.contract.js';
import type { PluginSource } from '../plugins/discovery/plugin-source.js';
import type { ISecretsVaultService } from '../secrets-vault/secrets-vault.contract.js';
import type { IToolManualService, ToolManualSummary } from './tool-manuals.contract.js';

/**
 * Deleting ONE tool — a `.tool` manual or one `mcp.json` server entry — from
 * its tool page, by an owner of the plugin that holds it.
 *
 * The OWNER verb, and the same verdict the plugin delete uses: `canOwner` on
 * the plugin's folder (owner lists only, no admin rescue). A tool inherits its
 * folder's rules, so the people who may delete the whole plugin are exactly
 * the people who may delete one thing in it; a writer who merely edits the
 * server does not get to make it vanish.
 *
 * What depends on the tool is said BEFORE it goes ({@link dependents}): the
 * skills whose `allowed-tools` name it, the other plugins that carry it, and
 * how many stored secrets sit under its name. Deletion then removes the
 * definition in one commit and wipes those secrets — every user's, because a
 * vault row under a namespace nothing declares is a credential nobody can see
 * or remove, and a later tool reusing the name would inherit it. The skills'
 * files are NOT touched: their `allowed-tools` entry becomes a dangling name,
 * which the skill page already surfaces.
 *
 * One kind of row is deliberately left behind: a key whose remainder starts
 * with `_`, which the UTCP encoding makes indistinguishable from a longer
 * tool's (see `isKeyInNamespace`). It is neither counted nor wiped, so the
 * dialog's number stays true to what goes.
 */

export interface ToolDependents {
  slug: string;
  name: string;
  /** `manual` — a `.tool` file; `server` — an entry in a plugin's mcp.json. */
  source: 'manual' | 'server';
  /** The plugin holding the tool — where the page returns after a delete. */
  plugin: { name: string; displayName: string };
  /** Skills (the caller can read) whose `allowed-tools` name this tool. */
  skills: { name: string; path: string }[];
  /** OTHER plugins that carry the tool — linking its folder, or declaring the same server. */
  plugins: { name: string; displayName: string }[];
  /** Stored values and shared client secrets under the tool's name, every user's. */
  storedKeys: number;
  /** Per-user sign-ins under the tool's name. */
  signIns: number;
}

export class ToolDeleteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ToolDeleteError';
  }
}

interface CommitDriver {
  runPendingCommit(
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
    opts?: { systemAuthorized?: boolean },
  ): Promise<void>;
  /** Whether a commit is sitting on the local branch unpushed — see {@link ToolDeleteService.deleteManual}. */
  hasUnpushedCommits(workspaceId: string): Promise<boolean>;
}

interface Located {
  tool: ToolManualSummary;
  source: 'manual' | 'server';
  plugin: PluginCatalogEntry;
  /** The plugin folder (repo-relative) the tool sits in. */
  folder: string;
}

/**
 * Whether a skill's `allowed-tools` entry names the tool — the same rule the
 * library applies (`neededToolsFor`): the manual name itself, or one of its
 * tools spelled `<manual>_<tool>` / `<manual>.<tool>`, case-insensitively.
 */
export function allowedToolNames(entry: string, toolName: string): boolean {
  const e = entry.toLowerCase();
  const n = toolName.toLowerCase();
  return e === n || e.startsWith(`${n}_`) || e.startsWith(`${n}.`);
}

/**
 * Own-property membership. `name in obj` answers for the PROTOTYPE too, so a
 * tool called `toString` or `constructor` would look declared by every
 * `mcpServers` map on the tree — a dependent list naming unrelated plugins,
 * and a delete that proceeds against a file the server is no longer in.
 */
function hasOwn(obj: object, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, name);
}

export class ToolDeleteService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly commits: CommitDriver,
    private readonly accessControl: IAccessControl,
    private readonly toolManuals: IToolManualService,
    private readonly skills: ISkillService,
    private readonly pluginIndex: IPluginIndexService,
    private readonly source: PluginSource,
    private readonly vault: Pick<ISecretsVaultService, 'countNamespace' | 'removeNamespace'>,
    private readonly kb: KbContext,
    private readonly disk: IFsProbe,
  ) {}

  private get kbDirName(): string {
    return this.kb.kbDirName;
  }

  /** What deleting `slug` would affect. Owner-gated like the delete itself. */
  async dependents(userEmail: string, slug: string): Promise<ToolDependents> {
    const { tool, source, plugin, folder } = await this.authorize(userEmail, slug);
    const [skills, plugins, secrets] = await Promise.all([
      this.dependentSkills(userEmail, tool.name),
      this.carryingPlugins(userEmail, tool, folder, plugin),
      this.vault.countNamespace(utcpNamespacePrefix(tool.name)),
    ]);
    return {
      slug: tool.slug,
      name: tool.name,
      source,
      plugin: { name: plugin.name, displayName: plugin.displayName },
      skills,
      plugins,
      storedKeys: secrets.keys,
      signIns: secrets.signIns,
    };
  }

  /** Delete the definition in one commit, then wipe its secrets. Returns the plugin it lived in. */
  async deleteTool(user: AuthUser, slug: string): Promise<{ plugin: string }> {
    const { tool, source, plugin, folder } = await this.authorize(user.email, slug);
    if (!plugin.linksAreManaged) {
      // A plugin read from an external format is edited in its own repository;
      // removing its file here would be undone by the next sync, or worse.
      throw new ToolDeleteError("This tool's plugin is managed in another format — delete it there.", 422);
    }
    const wsId = this.kb.defaultWorkspaceId();
    await this.workspaceService.getOrCreateForBranch(this.kb.defaultBranch);
    const kbRoot = path.join(await this.workspaceService.getWorkspacePath(wsId), this.kbDirName);

    if (source === 'manual') await this.deleteManual(user, wsId, kbRoot, tool);
    else await this.deleteServer(user, wsId, kbRoot, tool, folder);

    // The definition is gone at HEAD; the catalogs learn now rather than at
    // their TTL, so the cards, the sidebar and the agent's tool list agree on
    // the very next request.
    this.toolManuals.invalidate();
    this.pluginIndex.invalidate();
    // Only after the commit landed: a refused delete must leave the tool
    // exactly as it was, credentials included.
    await this.wipeSecrets(tool);
    return { plugin: plugin.name };
  }

  /**
   * Readable tool → the plugin holding it → the owner verdict on that plugin.
   * An unreadable tool is a 404 identical to an unknown one; a readable tool
   * the caller does not own is a 403 — they can already see it exists.
   */
  private async authorize(userEmail: string, slug: string): Promise<Located> {
    const tool = (await this.toolManuals.listAccessible(userEmail)).find((t) => t.slug === slug);
    if (!tool) throw new ToolDeleteError('No such tool.', 404);
    const source = tool.path.endsWith(`/${PLUGIN_MCP_FILE}`)
      ? 'server'
      : tool.path.toLowerCase().endsWith('.tool')
        ? 'manual'
        : null;
    const owned = await this.owningPlugin(userEmail, tool.path);
    if (!source || !owned) {
      throw new ToolDeleteError("Only the owners of this tool's plugin can delete it.", 403);
    }
    return { tool, source, ...owned };
  }

  /** The plugin whose folder holds `toolPath` — the deepest one — if the caller owns it. */
  private async owningPlugin(
    userEmail: string,
    toolPath: string,
  ): Promise<{ plugin: PluginCatalogEntry; folder: string } | null> {
    let best: { plugin: PluginCatalogEntry; folder: string } | null = null;
    for (const plugin of await this.pluginIndex.catalog()) {
      for (const folder of plugin.folders) {
        if (!toolPath.startsWith(`${folder}/`)) continue;
        if (!best || folder.length > best.folder.length) best = { plugin, folder };
      }
    }
    if (!best) return null;
    const owner = await this.accessControl.canOwner(this.kb.defaultWorkspaceId(), userEmail, best.folder);
    return owner ? best : null;
  }

  /**
   * Wipe the tool's namespace, RETRIED — the definition is already gone at
   * HEAD and cannot come back, so a vault that blinks once must not be what
   * leaves rows under a name nothing declares (a credential nobody can see or
   * remove, and one a later tool reusing the name would inherit).
   *
   * If it still will not go, the caller hears so in those words: the delete
   * itself happened, and the one action left is a manual one.
   */
  private async wipeSecrets(tool: ToolManualSummary): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.vault.removeNamespace(utcpNamespacePrefix(tool.name));
        return;
      } catch (err) {
        last = err;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    const why = last instanceof Error ? last.message : String(last);
    throw new ToolDeleteError(
      `The ${tool.name} tool was deleted, but its stored credentials could not be wiped (${why}). ` +
        'Remove them from Secrets before anything reuses the name.',
      500,
    );
  }

  private async dependentSkills(userEmail: string, toolName: string): Promise<ToolDependents['skills']> {
    // The caller's readable skills only: naming a skill somebody cannot read
    // would confirm it exists. `allowed-tools` has no bulk read, so one load
    // per skill; a skill that fails to load is not a dependent we can vouch for.
    const readable = await this.skills.listSkills(userEmail);
    const loaded = await Promise.all(
      readable.map(async (s) => {
        const got = await this.skills.getSkill(userEmail, s.name).catch(() => null);
        const allowed = got?.ok && got.kind === 'skill' ? (got.skill.allowedTools ?? []) : [];
        return allowed.some((e) => allowedToolNames(e, toolName)) ? { name: s.name, path: s.path } : null;
      }),
    );
    return loaded.filter((s): s is { name: string; path: string } => s !== null);
  }

  /**
   * Other plugins that carry this tool: one linking a root the tool sits under,
   * or one whose servers declare the same name (a registry profile shared
   * across bundles). The tool's own plugin is not a dependent — it is the home.
   */
  private async carryingPlugins(
    userEmail: string,
    tool: ToolManualSummary,
    folder: string,
    home: PluginCatalogEntry,
  ): Promise<ToolDependents['plugins']> {
    const wsId = this.kb.defaultWorkspaceId();
    let discovered;
    try {
      await this.workspaceService.getOrCreateForBranch(this.kb.defaultBranch);
      const kbRoot = path.join(await this.workspaceService.getWorkspacePath(wsId), this.kbDirName);
      discovered = await this.source.discover(kbRoot);
    } catch (err) {
      // A partial answer is the one thing this list must never be: "no other
      // plugin carries it" is what the owner deletes ON, so a scan that did
      // not finish refuses rather than reassures.
      throw new ToolDeleteError(
        `Couldn't read which plugins carry this tool (${err instanceof Error ? err.message : String(err)}) — nothing was deleted.`,
        503,
      );
    }
    if (discovered.unreadable.length > 0) {
      // A HOLE is a plugin that exists and could not be read. Listing the
      // rest as if it were the whole answer would let the dialog vouch for a
      // tree it never saw.
      throw new ToolDeleteError(
        `${discovered.unreadable.length === 1 ? 'A plugin' : `${discovered.unreadable.length} plugins`} could not be read, so what carries this tool cannot be listed in full — nothing was deleted.`,
        503,
      );
    }
    const catalog = await this.pluginIndex.catalog();
    const candidates = discovered.plugins.filter((p) => {
      if (p.folder === folder || p.name === home.name) return false;
      const links = p.linkedRoots.some((r) => tool.path === r || tool.path.startsWith(`${r.replace(/\/+$/, '')}/`));
      const declares = p.mcpServers !== null && hasOwn(p.mcpServers, tool.name);
      return links || declares;
    });
    // Named only to a caller who can read the plugin's folder: a dependent
    // list is not a side door onto which plugins exist.
    const readable = await Promise.all(
      candidates.map((p) => this.accessControl.canRead(wsId, userEmail, p.folder)),
    );
    const out = new Map<string, { name: string; displayName: string }>();
    candidates.forEach((p, i) => {
      if (!readable[i]) return;
      const entry = catalog.find((c) => c.name === p.name);
      out.set(p.name, { name: p.name, displayName: entry?.displayName ?? p.displayName });
    });
    return [...out.values()];
  }

  /**
   * Park-then-commit, as the plugin delete does: the file is renamed to a
   * dot-prefixed sibling the scanner ignores, the deletion committed, and only
   * a landed commit lets the parked bytes go. A refused commit renames it
   * back, so a failed delete is a no-op.
   */
  private async deleteManual(user: AuthUser, wsId: string, kbRoot: string, tool: ToolManualSummary): Promise<void> {
    const abs = path.join(kbRoot, ...tool.path.split('/'));
    if ((await this.disk.lstatOrNull(abs))?.isFile() !== true) throw new ToolDeleteError('No such tool.', 404);
    const parked = path.join(path.dirname(abs), `.deleting-${randomUUID()}`);
    await fs.rename(abs, parked);
    try {
      await this.commits.runPendingCommit(wsId, this.kb.defaultBranch, `${this.kbDirName}/${tool.path}`, user, {
        // The route authorized the delete with the owner verb; see class note.
        systemAuthorized: true,
      });
    } catch (err) {
      // Restore ONLY when nothing landed. The pipeline commits locally and
      // THEN pushes, so a refused push leaves a commit that already removed
      // the file: renaming it back there would leave the working tree dirty
      // against HEAD — re-adding, on the next commit, the very tool this one
      // deleted, which is the state the workflow layer's own recovery
      // misreads (McpServerEditService refuses to touch the tree for the same
      // reason). A probe that itself fails counts as "a commit may exist": the
      // park survives, dot-prefixed and invisible to the scanner, for a person
      // to clear — a delete must never destroy more than it names.
      const committed = await this.commits.hasUnpushedCommits(wsId).catch(() => true);
      if (!committed) await fs.rename(parked, abs).catch(() => {});
      throw err;
    }
    await fs.rm(parked, { force: true }).catch(() => {});
  }

  /**
   * Remove one server from BOTH files that describe it — the entry in
   * `mcp.json` and its half in `plugin.json`'s extensions block — and commit
   * them together, the way a server edit does. Leaving the extensions half
   * behind would re-declare auth for a server that no longer exists.
   */
  private async deleteServer(
    user: AuthUser,
    wsId: string,
    kbRoot: string,
    tool: ToolManualSummary,
    folder: string,
  ): Promise<void> {
    const pluginDir = path.join(kbRoot, ...path.posix.dirname(tool.path).split('/'));
    const mcpAbs = path.join(pluginDir, PLUGIN_MCP_FILE);
    const manifestAbs = path.join(pluginDir, PLUGIN_MANIFEST_FILE);
    const mcp = await this.disk.readJsonObject(mcpAbs);
    const servers = mcp?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers) || !hasOwn(servers, tool.name)) {
      throw new ToolDeleteError('No such server.', 404);
    }
    delete (servers as Record<string, unknown>)[tool.name];

    const manifest = await this.disk.readJsonObject(manifestAbs);
    const extServers = (
      (manifest?.extensions as Record<string, unknown> | undefined)?.[HEXIS_EXTENSION_NS] as
        | Record<string, unknown>
        | undefined
    )?.mcpServers;
    const touchManifest =
      manifest !== null &&
      extServers !== null &&
      typeof extServers === 'object' &&
      !Array.isArray(extServers) &&
      hasOwn(extServers, tool.name);
    if (touchManifest) delete (extServers as Record<string, unknown>)[tool.name];

    const [mcpBefore, manifestBefore] = await Promise.all([
      fs.readFile(mcpAbs, 'utf8'),
      touchManifest ? fs.readFile(manifestAbs, 'utf8') : Promise.resolve(null),
    ]);
    try {
      await fs.writeFile(mcpAbs, `${JSON.stringify(mcp, null, 2)}\n`, 'utf8');
      if (touchManifest) await fs.writeFile(manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    } catch (err) {
      await fs.writeFile(mcpAbs, mcpBefore, 'utf8').catch(() => {});
      if (manifestBefore !== null) await fs.writeFile(manifestAbs, manifestBefore, 'utf8').catch(() => {});
      throw err;
    }
    // Commit-stage failures propagate as-is: the pipeline may already hold a
    // local commit, and rewriting the tree under it is the state its own
    // recovery misreads (same contract as McpServerEditService).
    await this.commits.runPendingCommit(wsId, this.kb.defaultBranch, `${this.kbDirName}/${folder}`, user, {
      systemAuthorized: true,
    });
  }
}

