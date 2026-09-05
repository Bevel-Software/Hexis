import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_BRANCH,
  PLUGIN_MANIFEST_FILE,
  isPersonalPluginFolder,
  linkedSkillRoots,
  normalizeSkillRoot,
  pluginManifestName,
  renderPluginManifest,
  skillUnderRoot,
  withLinkedSkillRoots,
  type AuthUser,
} from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { AccessMutationService, accessMdPathForFolder } from '../access/access-mutation.service.js';
import { PLUGIN_TOKEN_PREFIX } from '../access-model/access-grammar.js';
import type { Principal } from '../access-model/access-splice.js';
import { WorkspaceMutex } from '../kb-fs/mutex.js';
import type { ISkillService } from '../skills/skills.contract.js';
import type { ProvisionCommitDriver } from './plugin-provision.service.js';
import { linksWorkspaceId, type PluginLinkIndex } from './plugin-links.js';

/** A refusal the route passes through: message + HTTP status + a machine-readable kind. */
export class PluginLinkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'PluginLinkError';
  }
}

/**
 * Linking shared skills into plugins — the writer behind "add an existing
 * skill to this plugin".
 *
 * A link is TWO edits that only make sense together:
 *
 *   1. the skill's root goes into the plugin manifest's
 *      `extensions["software.bevel.hexis"].skills` list (see
 *      `HEXIS_LINKED_SKILLS_KEY`), which is what the catalog, the plugin page
 *      and the compiled distribution read;
 *   2. the skill folder's own `access.md` grants `read` to
 *      `plugin/<Name>/read` and `write` to `plugin/<Name>/write`, which is
 *      what lets the plugin's members actually read it — ownership decides,
 *      the plugin is a view (see `plugin-principals.ts`).
 *
 * Which is why linking needs write on BOTH sides: on the plugin folder (to
 * edit its manifest) and on the skill's root (to edit its access rules). A
 * manager who lacks the second gets a 409 the UI turns into "request write
 * access", not a link that silently shares nothing.
 *
 * Unlinking removes the manifest entry, and revokes the two tokens only when
 * the actor may edit the skill's rules — otherwise the grant stays, and the
 * skill page says so, for a skill editor to remove.
 *
 * Repair re-grants the tokens for a link that exists but whose grant was
 * hand-removed: the amber dot's one action.
 *
 * Every operation is serialised on the plugin's manifest slug (the same key
 * provisioning locks on) and lands as ordinary default-branch commits through
 * the pending-commit driver, so the write gate and the per-user push gate
 * apply exactly as they do to any edit.
 */
export class PluginLinksService {
  private readonly locks = new WorkspaceMutex();
  private readonly mutation: AccessMutationService;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly commits: ProvisionCommitDriver,
    private readonly accessControl: IAccessControl,
    private readonly skillService: ISkillService,
    private readonly links: PluginLinkIndex,
    private readonly kbDirName: string,
    private readonly events?: {
      emit(event: { kind: 'fs-tree-changed'; workspaceId: string; branch: string }): void;
    },
    private readonly onChanged?: () => void,
  ) {
    this.mutation = new AccessMutationService(workspaceService, accessControl, kbDirName);
  }

  async link(user: AuthUser, plugin: string, rawRoot: string): Promise<{ root: string; skills: string[] }> {
    const folder = await this.pluginFolder(plugin);
    const root = this.rootOrThrow(rawRoot);
    const wsId = linksWorkspaceId();
    await this.requirePluginWrite(wsId, user, folder);
    const skills = await this.resolvedSkills(root);
    if (skills.length === 0) {
      throw new PluginLinkError(
        `"${root}" holds no released skill. Link a skill folder, or a folder that contains skills.`,
        422,
        { kind: 'no-skills', root },
      );
    }
    if (!(await this.accessControl.canWrite(wsId, user.email, accessMdPathForFolder(root)))) {
      // The manager may edit the plugin but not the skill's rules — the link
      // would share nothing. The UI offers the request path on this shape.
      throw new PluginLinkError(
        `You can't change who may read "${root}". Ask its editors for write access first.`,
        409,
        { kind: 'needs-skill-write', root },
      );
    }
    return this.locks.run(`plugin:${pluginManifestName(folder)}`, async () => {
      const { manifest, manifestRel } = await this.readManifest(wsId, folder);
      const roots = linkedSkillRoots(manifest);
      if (!roots.includes(root)) {
        await this.workspaceService.writeFile(
          wsId,
          manifestRel,
          `${JSON.stringify(withLinkedSkillRoots(manifest, [...roots, root]), null, 2)}\n`,
        );
        await this.commits.runPendingCommit(wsId, DEFAULT_BRANCH, manifestRel, user);
      }
      await this.grantTokens(wsId, user, folder, root);
      this.changed(wsId);
      return { root, skills };
    });
  }

  async unlink(user: AuthUser, plugin: string, rawRoot: string): Promise<{ root: string; revoked: boolean }> {
    const folder = await this.pluginFolder(plugin);
    const root = this.rootOrThrow(rawRoot);
    const wsId = linksWorkspaceId();
    await this.requirePluginWrite(wsId, user, folder);
    return this.locks.run(`plugin:${pluginManifestName(folder)}`, async () => {
      const { manifest, manifestRel } = await this.readManifest(wsId, folder);
      const roots = linkedSkillRoots(manifest);
      if (!roots.includes(root)) {
        throw new PluginLinkError(`"${root}" is not linked into ${folder}.`, 404, { kind: 'not-linked', root });
      }
      await this.workspaceService.writeFile(
        wsId,
        manifestRel,
        `${JSON.stringify(withLinkedSkillRoots(manifest, roots.filter((r) => r !== root)), null, 2)}\n`,
      );
      await this.commits.runPendingCommit(wsId, DEFAULT_BRANCH, manifestRel, user);

      // Revoke only where the actor may edit the skill's rules; otherwise the
      // grant stays for a skill editor to remove — never a silent no-op that
      // pretends it happened.
      let revoked = false;
      if (await this.accessControl.canWrite(wsId, user.email, accessMdPathForFolder(root))) {
        let changed = false;
        for (const principal of this.tokens(folder)) {
          const r = await this.mutation.revoke(wsId, 'folder', root, principal, user.email, undefined, {
            tokenMatch: 'exact',
          });
          changed ||= r.changed;
        }
        if (changed) {
          await this.commits.runPendingCommit(
            wsId,
            DEFAULT_BRANCH,
            `${this.kbDirName}/${accessMdPathForFolder(root)}`,
            user,
          );
        }
        revoked = true;
      }
      this.changed(wsId);
      return { root, revoked };
    });
  }

  async repair(user: AuthUser, plugin: string, rawRoot: string): Promise<{ root: string }> {
    const folder = await this.pluginFolder(plugin);
    const root = this.rootOrThrow(rawRoot);
    const wsId = linksWorkspaceId();
    const { manifest } = await this.readManifest(wsId, folder);
    if (!linkedSkillRoots(manifest).includes(root)) {
      throw new PluginLinkError(`"${root}" is not linked into ${folder}.`, 404, { kind: 'not-linked', root });
    }
    if (!(await this.accessControl.canWrite(wsId, user.email, accessMdPathForFolder(root)))) {
      throw new PluginLinkError(`You can't change who may read "${root}".`, 403, {
        kind: 'needs-skill-write',
        root,
      });
    }
    return this.locks.run(`plugin:${pluginManifestName(folder)}`, async () => {
      await this.grantTokens(wsId, user, folder, root);
      this.changed(wsId);
      return { root };
    });
  }

  // --- internal --------------------------------------------------------------

  /** The two grants a link carries: members read, managers write. */
  private tokens(folder: string): Principal[] {
    return [
      { kind: 'role', role: `${PLUGIN_TOKEN_PREFIX}${folder}/read` },
      { kind: 'role', role: `${PLUGIN_TOKEN_PREFIX}${folder}/write` },
    ];
  }

  private async grantTokens(wsId: string, user: AuthUser, folder: string, root: string): Promise<void> {
    const [read, write] = this.tokens(folder);
    const a = await this.mutation.grant(wsId, 'folder', root, 'read', read);
    const b = await this.mutation.grant(wsId, 'folder', root, 'write', write);
    if (a.changed || b.changed) {
      await this.commits.runPendingCommit(wsId, DEFAULT_BRANCH, `${this.kbDirName}/${a.editPath}`, user);
    }
  }

  private rootOrThrow(raw: string): string {
    const root = normalizeSkillRoot(raw);
    if (root === null) {
      throw new PluginLinkError('A skill path must be a repo-relative folder path.', 422, { kind: 'bad-root' });
    }
    return root;
  }

  /** Released skills under the root — the catalog's answer, not the file system's. */
  private async resolvedSkills(root: string): Promise<string[]> {
    return (await this.skillService.listSkills(undefined))
      .map((s) => s.path)
      .filter((p) => skillUnderRoot(p, root));
  }

  /** The exact on-disk plugin folder for `name`, or 404 — personal folders are not plugins. */
  private async pluginFolder(name: string): Promise<string> {
    const trimmed = name.trim();
    if (!trimmed || isPersonalPluginFolder(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
      throw new PluginLinkError('Unknown plugin', 404, { kind: 'unknown-plugin' });
    }
    const membership = await this.links.membership();
    const links = membership.byPlugin.get(trimmed);
    if (!links) {
      throw new PluginLinkError('Unknown plugin', 404, { kind: 'unknown-plugin' });
    }
    if (!links.linksAreManaged) {
      // A dialect plugin's links live in a file this platform does not write.
      throw new PluginLinkError(
        `${trimmed} is read from an external plugin format; edit its links in that repository.`,
        409,
        { kind: 'read-only-links' },
      );
    }
    return trimmed;
  }

  /** The repo-relative folder of a known plugin (any depth). */
  private async folderOf(plugin: string): Promise<string> {
    const links = (await this.links.membership()).byPlugin.get(plugin);
    if (!links) throw new PluginLinkError('Unknown plugin', 404, { kind: 'unknown-plugin' });
    return links.folder;
  }

  private async requirePluginWrite(wsId: string, user: AuthUser, plugin: string): Promise<void> {
    if (!(await this.accessControl.canWrite(wsId, user.email, await this.folderOf(plugin)))) {
      // Same answer as an unknown plugin, so probing confirms nothing.
      throw new PluginLinkError('Unknown plugin', 404, { kind: 'unknown-plugin' });
    }
  }

  private async readManifest(
    wsId: string,
    plugin: string,
  ): Promise<{ manifest: Record<string, unknown>; manifestRel: string }> {
    const folder = await this.folderOf(plugin);
    const manifestRel = `${this.kbDirName}/${folder}/${PLUGIN_MANIFEST_FILE}`;
    const abs = path.join(await this.workspaceService.getWorkspacePath(wsId), manifestRel);
    let manifest: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(abs, 'utf-8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        manifest = parsed as Record<string, unknown>;
      }
    } catch {
      /* absent or unparsable — a pre-manifest folder gets a fresh minimal manifest */
    }
    return {
      manifest: manifest ?? (JSON.parse(renderPluginManifest(path.posix.basename(folder))) as Record<string, unknown>),
      manifestRel,
    };
  }

  private changed(wsId: string): void {
    this.links.invalidate();
    this.accessControl.invalidate(wsId);
    this.onChanged?.();
    this.events?.emit({ kind: 'fs-tree-changed', workspaceId: wsId, branch: DEFAULT_BRANCH });
  }
}
