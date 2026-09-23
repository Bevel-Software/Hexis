import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_BRANCH,
  PLUGIN_MANIFEST_FILE,
  linkedSkillRoots,
  normalizeSkillRoot,
  pluginManifestName,
  renderPluginManifest,
  skillUnderRoot,
  withLinkedSkillRoots,
  type AuthUser,
} from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { isAbsence } from '../../shared/fs.contract.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { AccessMutationService, accessMdPathForFolder } from '../access/access-mutation.service.js';
import { pluginPrincipalKey } from '../access-model/access-grammar.js';
import type { Principal } from '../access-model/access-splice.js';
import { WorkspaceMutex } from '../kb-fs/mutex.js';
import type { ISkillService } from '../skills/skills.contract.js';
import { logger } from '../../shared/logging.js';
import type { ProvisionCommitDriver } from './plugin-provision.service.js';
import { linksWorkspaceId, type PluginLinkIndex } from './plugin-links.js';

const log = logger('plugins');

/** Who may edit one skill root's access file, in the terms the banner names them. */
export interface LinkEditors {
  roles: string[];
  users: { name: string; email: string }[];
}

/** One link the automatic repair left alone, and why — see `repairAll`. */
export interface UnrepairedLink {
  /** Repo-relative root, as the manifest declares it. */
  root: string;
  /**
   * `needs-skill-write` — the viewer may not write the root's access file, so
   * nothing was attempted; `failed` — the write was attempted and did not
   * land. Both leave the link broken and both keep the banner.
   */
  reason: 'needs-skill-write' | 'failed';
  /** The skills the plugin's members still cannot read through the root. */
  skills: { path: string; name: string }[];
  /** Who can repair it from the skill page. */
  editors: LinkEditors;
}

/** What one page-open repair did and what it could not do. */
export interface LinkRepairReport {
  /** Roots whose two grant lines are now in place (silent: nothing to show). */
  repaired: string[];
  /** What is still broken, and who can fix it. */
  skipped: UnrepairedLink[];
}

/**
 * The commit subject for an automatic repair. It names the plugin, the root
 * and the fact that nobody asked for it — the commit is the ONLY trace a
 * silent repair leaves, so the history has to explain itself. Falls back to
 * the path-derived default when a very long root would blow the 200-character
 * subject limit: a missed explanation is not worth a failed repair.
 */
function repairSummary(plugin: string, root: string): string | undefined {
  const subject = `Repair link: ${plugin} → ${root} (automatic, on opening the plugin page)`;
  return subject.length <= 200 ? subject : undefined;
}

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
 * hand-removed — the amber dot's one action, run one link at a time from the
 * skill page, or over a whole plugin's links by `repairAll` the moment
 * somebody who may write that plugin opens its page.
 *
 * Every operation is serialised on BOTH sides it writes — the plugin's
 * manifest slug (the same key provisioning locks on) and the skill root whose
 * access.md carries the grant — and lands as ordinary default-branch commits
 * through the pending-commit driver, so the write gate and the per-user push
 * gate apply exactly as they do to any edit.
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
    return this.locks.runAll(this.lockKeys(folder, root), async () => {
      const { manifest, manifestRel } = await this.readManifest(wsId, folder);
      const roots = linkedSkillRoots(manifest);
      // Manifest FIRST, grant second — two commits, deliberately in this
      // order. The two files live in different folders and the commit
      // pipeline is path-scoped, so there is no single commit to be had; what
      // can be chosen is which half-state a failure leaves. Listed-but-not-
      // shared is the visible one: the link index reports the missing grant,
      // the card wears the amber dot, and Repair finishes the job. The other
      // order would leave shared-but-not-listed — an over-share nothing
      // surfaces.
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
    return this.locks.runAll(this.lockKeys(folder, root), async () => {
      const { manifest, manifestRel } = await this.readManifest(wsId, folder);
      const roots = linkedSkillRoots(manifest);
      if (!roots.includes(root)) {
        throw new PluginLinkError(`"${root}" is not linked into ${folder}.`, 404, { kind: 'not-linked', root });
      }

      // Revoke FIRST, manifest second — the mirror of `link`'s ordering and
      // for the same reason: a failure between the two must leave the
      // visible half-state (listed, no grant → amber dot, Repair), never the
      // silent one (unlisted, still shared). Revoke only where the actor may
      // edit the skill's rules; otherwise the grant stays for a skill editor
      // to remove — never a silent no-op that pretends it happened.
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
      await this.workspaceService.writeFile(
        wsId,
        manifestRel,
        `${JSON.stringify(withLinkedSkillRoots(manifest, roots.filter((r) => r !== root)), null, 2)}\n`,
      );
      await this.commits.runPendingCommit(wsId, DEFAULT_BRANCH, manifestRel, user);
      this.changed(wsId);
      return { root, revoked };
    });
  }

  /**
   * Re-grant one link's two tokens. The skill EDITOR's verb (the plugin side
   * is not consulted): the amber dot's one manual action, and the single
   * write the automatic repair runs too — see {@link repairAll}.
   *
   * `summary` is the commit subject when the caller has a better one than the
   * path-derived default; the automatic repair passes one that says it was
   * automatic, because the commit is the only trace it leaves.
   */
  async repair(
    user: AuthUser,
    plugin: string,
    rawRoot: string,
    opts?: { summary?: string },
  ): Promise<{ root: string }> {
    const folder = await this.pluginFolder(plugin);
    const root = this.rootOrThrow(rawRoot);
    const wsId = linksWorkspaceId();
    // Everything under the lock, the manifest read included: a repair that
    // checked the link and then waited on an unlink would re-grant a root the
    // manifest no longer names.
    return this.locks.runAll(this.lockKeys(folder, root), async () => {
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
      await this.grantTokens(wsId, user, folder, root, opts?.summary);
      this.changed(wsId);
      return { root };
    });
  }

  /**
   * Repair EVERY link of `plugin` that is missing its grants — what opening
   * the plugin's page runs for someone who may write the plugin.
   *
   * Two gates, in this order: the caller must be able to write the PLUGIN
   * (this is the plugin's page repairing its own links, not a way to write
   * other people's access files), and then, per root, to write that root's
   * access file. A root they cannot write is left exactly as it is and comes
   * back in `skipped` with the people who CAN write it, which is the sentence
   * the banner then says. Nothing comes back for a root that was repaired:
   * the commit is the trace, the page simply renders with the link healthy.
   *
   * Root by root through {@link repair} — the same write, the same manifest
   * check, the same pair of locks — so the automatic path and the button on
   * the skill page can never write different things. Each root's failure is
   * caught into `skipped`: one unwritable file must not cost the others their
   * repair, nor the page its render.
   */
  async repairAll(user: AuthUser, plugin: string): Promise<LinkRepairReport> {
    const folder = await this.pluginFolder(plugin);
    const wsId = linksWorkspaceId();
    await this.requirePluginWrite(wsId, user, folder);
    // Read the work list ONCE, before the first write: `repair` invalidates
    // the index, and re-reading it per root would rebuild the whole membership
    // between every commit.
    const work = (await this.links.membership()).byPlugin.get(folder)?.ungrantedRoots ?? [];
    if (work.length === 0) return { repaired: [], skipped: [] };
    const named = new Map((await this.skillService.listSkills(undefined)).map((s) => [s.path, s.name]));
    const repaired: string[] = [];
    const skipped: UnrepairedLink[] = [];
    for (const item of work) {
      try {
        await this.repair(user, folder, item.root, { summary: repairSummary(folder, item.root) });
        repaired.push(item.root);
      } catch (err) {
        const needsWrite = err instanceof PluginLinkError && err.payload.kind === 'needs-skill-write';
        if (!needsWrite) log.warn('automatic link repair failed:', { plugin: folder, root: item.root, err });
        skipped.push({
          root: item.root,
          reason: needsWrite ? 'needs-skill-write' : 'failed',
          skills: item.skills.map((path) => ({ path, name: named.get(path) ?? path.split('/').pop() ?? path })),
          editors: await this.editorsOf(wsId, item.root),
        });
      }
    }
    return { repaired, skipped };
  }

  // --- internal --------------------------------------------------------------

  /**
   * Who may edit a root's access file — the principals the banner names as
   * the people who can repair a link this viewer cannot.
   *
   * Plugin principals are dropped: `plugin/gtm/write` is a real holder of the
   * verb, and naming it in a sentence addressed to a person says nothing they
   * could act on. The eligible lists carry emails and no display names, so an
   * email stands in — every name here has to be something a reader can go and
   * ask. A lookup that fails names nobody rather than failing the whole
   * repair — the banner has a sentence for that.
   */
  private async editorsOf(wsId: string, root: string): Promise<LinkEditors> {
    try {
      const writers = await this.accessControl.eligibleWriters(wsId, accessMdPathForFolder(root));
      return {
        roles: writers.principals
          ? writers.principals.filter((p) => p.kind !== 'plugin').map((p) => p.name)
          : writers.roles,
        users: writers.users.map((u) => ({ name: u.name || u.email, email: u.email })),
      };
    } catch (err) {
      log.warn("couldn't resolve a skill root's editors:", { root, err });
      return { roles: [], users: [] };
    }
  }

  /**
   * ONE reservation for both sides of a link: the plugin's manifest AND the
   * skill root's access.md. Two plugins linking the same root write the same
   * file, and serialising on the plugin alone let them interleave, one splice
   * overwriting the other's grant. `runAll` takes both keys atomically, so
   * nothing nests and no ordering discipline is needed.
   */
  private lockKeys(folder: string, root: string): string[] {
    return [`plugin:${pluginManifestName(folder)}`, `root:${root}`];
  }

  /**
   * The two grants a link carries: members read, managers write — written as
   * the CANONICAL keys (slugged name), the spelling every comparison uses, so
   * a repeated link finds its grant and an unlink finds what to revoke
   * whatever the folder is called.
   */
  private tokens(folder: string): Principal[] {
    const slug = pluginManifestName(folder);
    return [
      { kind: 'role', role: pluginPrincipalKey(slug, 'read') },
      { kind: 'role', role: pluginPrincipalKey(slug, 'write') },
    ];
  }

  /**
   * The two lines, and a commit only if they were not already there — the
   * `changed` check is what makes re-linking, Repair and the page-open repair
   * idempotent rather than a stream of empty commits.
   */
  private async grantTokens(
    wsId: string,
    user: AuthUser,
    folder: string,
    root: string,
    summary?: string,
  ): Promise<void> {
    const [read, write] = this.tokens(folder);
    const a = await this.mutation.grant(wsId, 'folder', root, 'read', read);
    const b = await this.mutation.grant(wsId, 'folder', root, 'write', write);
    if (a.changed || b.changed) {
      await this.commits.runPendingCommit(wsId, DEFAULT_BRANCH, `${this.kbDirName}/${a.editPath}`, user, {
        summary,
      });
    }
  }

  private rootOrThrow(raw: string): string {
    const root = normalizeSkillRoot(raw);
    if (root === null) {
      throw new PluginLinkError('A skill path must be a repo-relative folder path.', 422, { kind: 'bad-root' });
    }
    return root;
  }

  /**
   * Released skills under the root — the catalog's answer, not the file
   * system's. The grant lands on the ROOT folder, so every skill beneath it
   * is reached by the link.
   */
  private async resolvedSkills(root: string): Promise<string[]> {
    const under = (await this.skillService.listSkills(undefined)).filter((s) => skillUnderRoot(s.path, root));
    return under.map((s) => s.path);
  }

  /**
   * The exact on-disk plugin folder for `name`, or 404. Personal folders are
   * not plugins, but that is the MEMBERSHIP's verdict (discovery marks the
   * `personal-*` prefix personal only directly under the root), not a rule
   * on the name — a nested plugin may be called anything.
   */
  private async pluginFolder(name: string): Promise<string> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) {
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
    let text: string | null = null;
    try {
      text = await fs.readFile(abs, 'utf-8');
    } catch (err) {
      // Only a PROVEN absence gets the fresh minimal manifest a pre-manifest
      // folder deserves. Any other failure must surface: the caller writes the
      // manifest back, and a skeleton over a real one would erase its
      // version, description and MCP extension block.
      if (!isAbsence(err)) throw err;
    }
    if (text !== null) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          manifest = parsed as Record<string, unknown>;
        }
      } catch {
        /* unparsable */
      }
      if (manifest === null) {
        throw new PluginLinkError(
          `${manifestRel} is not a JSON object; fix the manifest before changing its links.`,
          422,
          { kind: 'bad-manifest' },
        );
      }
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
