/**
 * "What does your team do?" — the one question a new knowledge base's admin
 * is asked after choosing where the knowledge lives, and the pages and skills
 * the answer adds.
 *
 * WHEN IT IS ASKED. Only of an admin, only until somebody has answered, and
 * only while the knowledge folder is still new (`knowledgeFolderIsNew`, the
 * same check the agent's first-run note makes): a knowledge base that already
 * has pages has outgrown starter pages, whoever wrote them. The answer —
 * a pack's id, or `none` for "I'll start from scratch" — is recorded as the
 * deployment setting `starterPack`, and its presence retires the question for
 * good.
 *
 * HOW THE PACK LANDS. As ONE commit on the default branch, authored by the
 * admin who chose it ("Add starter pages and skills for Sales"), through the
 * platform's own multi-file write: `LockingFilesystem.writeFiles`, the batch
 * the roles admin and the synced-groups writer use. It takes every path's
 * lock, writes, commits the set as one change and pushes it, and the
 * protected branch's write gate applies to it as to any write — which an
 * admin passes, as the root's `write: Admin` says. Nothing is overwritten: a
 * path that already exists when the locks are held is left out of the batch.
 *
 * ONE commit across every replica, too. The answer is recorded BEFORE the
 * pack is written, as an insert that yields to a row already there: the
 * database is what the replicas share, so of two admins choosing at once on
 * two of them, one claims the row and writes, and the other finds the claim
 * and is refused — the way a second click on one replica is refused by its
 * mutex. A write that then fails takes the claim back, so the question is
 * asked again; a write that lands is recorded already, whatever happens
 * after it.
 *
 * The pack's plugin is RUN BY the admin who applied it, the way a plugin made
 * with "Create a plugin" is run by its creator: its `access.md` names them
 * under read, write and owner (added to the rules the pack ships, which open
 * the plugin to the team), and a pack without a manifest gets the one
 * `renderPluginManifest` writes for any new plugin. A plugin folder that is
 * already there — or another plugin answering to the same name, at any
 * depth, by plugin discovery's own reading of the checkout — is left alone
 * entirely: a pack does not write into somebody else's plugin, and never
 * makes a second plugin with the name of one in a grouping folder.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PERSONAL_PLUGIN_PREFIX,
  PLUGIN_MANIFEST_FILE,
  pluginManifestName,
  renderPluginManifest,
  type AuthUser,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import { PushNeedsAgentResolutionError, WorkflowDomainError } from '../../shared/domain-errors.js';
import type { KbContext } from '../../shared/kb-context.js';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import type { DeploymentSettingsService } from '../settings/deployment-settings.service.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { FileChangeNotifier } from '../kb-fs/file-change-notifier.js';
import { LockingFilesystem } from '../kb-fs/locking-filesystem.js';
import { WorkspaceMutex } from '../kb-fs/mutex.js';
import {
  isUntouchedStarterPage,
  knowledgeFolderIsNew,
  type FirstRunStarter,
  type FirstRunStarterSource,
} from '../workspace/first-run.js';
import { pluginAccessMd, withCreatorGrants } from '../plugins/plugin-provision.service.js';
import type { PluginSource } from '../plugins/discovery/plugin-source.js';
import {
  NO_STARTER_PACK,
  loadStarterPacks,
  starterPackFiles,
  type StarterPack,
  type StarterPackFile,
  type StarterPackSummary,
} from './starter-packs.js';

const log = logger('starter-packs');

/** The deployment setting the choice is recorded in. */
export const STARTER_PACK_SETTING = 'starterPack';

/**
 * The catch-all pack, offered as "Something else": its name is that chip's
 * label, so the sentences that would name the team ("for Sales") leave it out.
 */
const CATCH_ALL_PACK = 'general';

/** `GET /api/onboarding/starter-packs`. */
export interface StarterPacksAnswer {
  /** Whether the caller should be asked: an admin, nothing chosen yet, a knowledge folder still new. */
  offered: boolean;
  /** The recorded answer — a pack's id, or `none` — or null while nobody has answered. */
  chosen: string | null;
  /** The packs to choose from, in chip order. Empty for a member, who is never asked. */
  packs: StarterPackSummary[];
  /** The chosen pack, for the first-page prompt — null when none was (or `none` was). */
  chosenPack: ChosenStarterPack | null;
}

export interface ChosenStarterPack {
  id: string;
  name: string;
  /** The team's own "write your first page" request. */
  firstPagePrompt: string;
  /**
   * The pack's pages that still hold exactly what the pack wrote, as
   * workspace-relative paths: placeholders, not pages anyone wrote, so they
   * do not tick "Write your first page".
   */
  starterPages: string[];
}

/** `POST /api/onboarding/starter-pack`. */
export interface StarterPackApplied {
  id: string;
  /** The chosen pack's name; null for `none`. */
  name: string | null;
  /** Pages and skills the commit added — what was absent, not what the pack holds. */
  pages: number;
  skills: number;
  /** What to tell the person: "Added 4 pages and 4 skills for Engineering." Empty for `none`. */
  summary: string;
}

/** A refusal the route passes through as its status. */
export class StarterPackError extends WorkflowDomainError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = 'StarterPackError';
  }
}

export interface StarterPackServiceDeps {
  /** The packs folder (`STARTER_PACKS_DIR`, else the packaged `starter-packs/`). */
  packsDir: string;
  kb: KbContext;
  workspaceService: Pick<WorkspaceService, 'getOrCreateForBranch' | 'getWorkspacePath' | 'hasBootstrappedWorkspace'>;
  workflow: IWorkflowService;
  adminAccess: IAdminAccessService;
  /** `recordIfAbsent` is the claim (see the module doc); `clear` takes it back when the write fails. */
  settings: Pick<DeploymentSettingsService, 'reload' | 'recordIfAbsent' | 'clear'>;
  accessControl: Pick<IAccessControl, 'invalidate'>;
  /** Plugin discovery over the checkout: what "a plugin by that name is already there" means, at any depth. */
  pluginSource: Pick<PluginSource, 'discover'>;
  /** The SSE bus: `fs-tree-changed` sends every open tree on the branch to fetch again. */
  events?: { emit(event: { kind: 'fs-tree-changed'; workspaceId: string; branch: string }): void };
  /** The post-commit hook catalogs refresh on — the plugin's skills appear without a restart. */
  fileChanges?: FileChangeNotifier;
}

export class StarterPackService implements FirstRunStarterSource {
  /**
   * One choice at a time on this replica: the second of two quick clicks
   * finds the first one's answer recorded. Across replicas the recorded
   * answer itself is the guard (see `choose`).
   */
  private readonly choosing = new WorkspaceMutex();

  constructor(private readonly deps: StarterPackServiceDeps) {}

  /** What the caller is offered, and what was chosen. */
  async status(user: Pick<AuthUser, 'email'>): Promise<StarterPacksAnswer> {
    const [chosen, isAdmin, packs] = await Promise.all([
      this.recordedChoice(),
      this.deps.adminAccess.isAdmin(user.email),
      loadStarterPacks(this.deps.packsDir),
    ]);
    const offered = isAdmin && chosen === null && packs.length > 0 && (await this.knowledgeIsNew(false));
    const pack = chosen && chosen !== NO_STARTER_PACK ? packs.find((p) => p.id === chosen) : undefined;
    return {
      offered,
      chosen,
      packs: isAdmin ? packs.map(({ id, name, description, order }) => ({ id, name, description, order })) : [],
      chosenPack: pack
        ? { id: pack.id, name: pack.name, firstPagePrompt: pack.firstPagePrompt, starterPages: await this.untouchedPages(pack) }
        : null,
    };
  }

  /**
   * Record `id` as the answer and, for a pack, add what it holds. `none`
   * records the skip and adds nothing. Refused with 403 for a member, 409
   * once the question is no longer asked (answered, or the knowledge base
   * has pages now), 404 for a pack that does not exist.
   */
  async choose(user: AuthUser, id: string): Promise<StarterPackApplied> {
    if (!(await this.deps.adminAccess.isAdmin(user.email))) {
      throw new StarterPackError('Only an admin can add starter pages.', 403);
    }
    return this.choosing.run('starter-pack', async () => {
      if ((await this.recordedChoice()) !== null) throw alreadyChosen();
      if (!(await this.knowledgeIsNew(true))) {
        throw new StarterPackError('This knowledge base already has pages, so starter pages are no longer offered.', 409);
      }
      const pack = id === NO_STARTER_PACK ? null : (await loadStarterPacks(this.deps.packsDir)).find((p) => p.id === id);
      if (id !== NO_STARTER_PACK && !pack) throw new StarterPackError(`There is no starter pack "${id}".`, 404);
      // THE CLAIM, before anything is written: an insert that yields to a
      // row already there, so a choice made on another replica a moment ago
      // is found here — refused the way a second click on this one is.
      if (!(await this.deps.settings.recordIfAbsent(STARTER_PACK_SETTING, id, user.id))) throw alreadyChosen();
      if (!pack) return { id, name: null, pages: 0, skills: 0, summary: '' };
      let added: string[];
      try {
        added = await this.apply(user, pack);
      } catch (err) {
        // Nothing landed: the claim goes, and the question is open again,
        // to be answered again. Should taking it back fail too, the question
        // stays closed on a knowledge base without the pack — said in the
        // log, since the caller already hears about the write.
        await this.deps.settings.clear(STARTER_PACK_SETTING).catch((clearErr: unknown) => {
          log.error('the starter pack was not added and its choice could not be taken back', { err: clearErr });
        });
        throw err;
      }
      const pages = added.filter((p) => this.isPage(p)).length;
      const skills = added.filter((p) => path.posix.basename(p) === 'SKILL.md').length;
      return { id: pack.id, name: pack.name, pages, skills, summary: summaryOf(pack, pages, skills) };
    });
  }

  /** The chosen pack as the agent's first-run note needs it, or null. */
  async firstRunStarter(): Promise<FirstRunStarter | null> {
    const chosen = await this.recordedChoice();
    if (!chosen || chosen === NO_STARTER_PACK) return null;
    const pack = (await loadStarterPacks(this.deps.packsDir)).find((p) => p.id === chosen);
    if (!pack) return null;
    const knowledgeDir = this.deps.kb.layout.knowledgeBaseDir;
    const pages = new Map<string, string>();
    for (const file of await this.pagesOf(pack)) {
      pages.set(file.repoPath.slice(knowledgeDir.length + 1), file.content as string);
    }
    return { name: pack.name, suggestedPages: pack.suggestedPages, pages };
  }

  /** The recorded answer, read from the database so every replica agrees. */
  private async recordedChoice(): Promise<string | null> {
    return (await this.deps.settings.reload(STARTER_PACK_SETTING)) || null;
  }

  /**
   * Whether the default branch's knowledge folder is still new. `clone`:
   * whether a knowledge base not checked out yet may be (the choice writes to
   * it, so it must); the status question never clones, and answers "no".
   */
  private async knowledgeIsNew(clone: boolean): Promise<boolean> {
    const { kb, workspaceService } = this.deps;
    if (!kb.isBranchModelConfigured()) return false;
    const workspaceId = kb.defaultWorkspaceId();
    if (!clone && !(await workspaceService.hasBootstrappedWorkspace(workspaceId))) return false;
    const ws = clone ? await workspaceService.getOrCreateForBranch(kb.defaultBranch) : { id: workspaceId };
    const root = await workspaceService.getWorkspacePath(ws.id);
    return knowledgeFolderIsNew(path.join(root, kb.kbDirName, kb.layout.knowledgeBaseDir));
  }

  /** The pack's pages: its text files under the knowledge folder. */
  private async pagesOf(pack: StarterPack): Promise<StarterPackFile[]> {
    const files = await starterPackFiles(pack, this.deps.kb.layout);
    return files.filter((f) => f.root === 'KnowledgeBase' && typeof f.content === 'string' && this.isPage(f.repoPath));
  }

  /** A page: a file under the knowledge folder that is not its access rules. */
  private isPage(repoOrWsPath: string): boolean {
    const { kbDirName, layout } = this.deps.kb;
    const rel = repoOrWsPath.startsWith(`${kbDirName}/`) ? repoOrWsPath.slice(kbDirName.length + 1) : repoOrWsPath;
    return rel.startsWith(`${layout.knowledgeBaseDir}/`) && path.posix.basename(rel) !== 'access.md';
  }

  /** The pack's pages still as it wrote them, workspace-relative. Never clones. */
  private async untouchedPages(pack: StarterPack): Promise<string[]> {
    const { kb, workspaceService } = this.deps;
    try {
      if (!kb.isBranchModelConfigured()) return [];
      const workspaceId = kb.defaultWorkspaceId();
      if (!(await workspaceService.hasBootstrappedWorkspace(workspaceId))) return [];
      const root = await workspaceService.getWorkspacePath(workspaceId);
      const out: string[] = [];
      for (const page of await this.pagesOf(pack)) {
        const wsPath = `${kb.kbDirName}/${page.repoPath}`;
        if (await isUntouchedStarterPage(path.join(root, ...wsPath.split('/')), page.content as string)) out.push(wsPath);
      }
      return out;
    } catch (err) {
      // A courtesy for the first-page step; an unreadable clone just means
      // every page counts as written.
      log.debug('could not tell which starter pages are untouched', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Write the pack's absent files to the default branch as one commit; resolve to the paths written. */
  private async apply(user: AuthUser, pack: StarterPack): Promise<string[]> {
    const { kb, workspaceService, workflow } = this.deps;
    const branch = kb.defaultBranch;
    const ws = await workspaceService.getOrCreateForBranch(branch);
    const basePath = await workspaceService.getWorkspacePath(ws.id);
    const writes = await this.plan(user, pack, path.join(basePath, kb.kbDirName));
    const fsys = new LockingFilesystem(
      { basePath, contained: true },
      { workflow, workspaceId: ws.id, branch, user, kbDirName: kb.kbDirName, fileChanges: this.deps.fileChanges },
    );
    let written: string[] = [];
    try {
      await fsys.writeFiles(writes, commitSubjectOf(pack), [], async (candidates) => {
        // Judged with every lock held: only what is STILL absent lands, so
        // a page someone made a moment ago is never replaced.
        const absent: (typeof candidates)[number][] = [];
        for (const w of candidates) {
          if (!(await exists(path.join(basePath, ...w.path.split('/'))))) absent.push(w);
        }
        written = absent.map((w) => w.path);
        return absent;
      });
    } catch (err) {
      // The commit landed and only its push is waiting: the pending-commit
      // worker retries it, and the sync banner says so. The pack IS added.
      if (!(err instanceof PushNeedsAgentResolutionError)) throw err;
      log.warn(`starter pack "${pack.id}" committed; its push is being retried`, { error: err.message });
    }
    if (written.length > 0) {
      // The plugin's rules joined the access model.
      this.deps.accessControl.invalidate(ws.id);
      this.deps.events?.emit({ kind: 'fs-tree-changed', workspaceId: ws.id, branch });
    }
    return written;
  }

  /**
   * The batch to write, workspace-relative: every pack file, with each plugin
   * the pack carries made the admin's (see the module doc) — or left out
   * whole when a plugin by that name is already there: a folder of that name
   * at the plugins root, whatever it holds, or a plugin discovery lists under
   * the same slug at any depth (one in a grouping folder included — the
   * catalog would show two plugins of one name, and a grant would reach the
   * wrong one). Refused outright when discovery could not read part of the
   * checkout: a name cannot be proved free over a hole.
   */
  private async plan(user: AuthUser, pack: StarterPack, repoDir: string): Promise<{ path: string; content: string | Buffer }[]> {
    const { kbDirName, layout } = this.deps.kb;
    const files = await starterPackFiles(pack, layout);
    const [existingFolders, discovered] = await Promise.all([
      childNames(path.join(repoDir, layout.pluginsDir)),
      this.deps.pluginSource.discover(repoDir),
    ]);
    if (discovered.unreadable.length > 0) {
      throw new StarterPackError(
        `Some of the knowledge base could not be read (${discovered.unreadable.join(', ')}), so the pack cannot be checked against the plugins already there. Try again.`,
        503,
      );
    }
    const writes: { path: string; content: string | Buffer }[] = [];
    const plugins = new Map<string, StarterPackFile[]>();
    for (const file of files) {
      if (file.root !== 'Plugins') {
        writes.push({ path: `${kbDirName}/${file.repoPath}`, content: file.content });
        continue;
      }
      const folder = file.repoPath.slice(layout.pluginsDir.length + 1).split('/')[0]!;
      plugins.set(folder, [...(plugins.get(folder) ?? []), file]);
    }
    for (const [folder, pluginFiles] of plugins) {
      const slug = pluginManifestName(folder);
      if (slug.startsWith(PERSONAL_PLUGIN_PREFIX)) {
        log.warn(`starter pack "${pack.id}": "${folder}" is a personal folder's name — plugin skipped.`);
        continue;
      }
      const taken =
        existingFolders.find((name) => name.toLowerCase() === folder.toLowerCase() || pluginManifestName(name) === slug) ??
        discovered.plugins.find((p) => pluginManifestName(p.name) === slug)?.folder;
      if (taken) {
        log.info(`starter pack "${pack.id}": a plugin "${taken}" is already there — its files are left as they are.`);
        continue;
      }
      const root = `${layout.pluginsDir}/${folder}`;
      let shippedAccess: string | null = null;
      let hasManifest = false;
      for (const file of pluginFiles) {
        if (file.repoPath === `${root}/access.md`) {
          shippedAccess = typeof file.content === 'string' ? file.content : null;
          continue;
        }
        if (file.repoPath === `${root}/${PLUGIN_MANIFEST_FILE}`) hasManifest = true;
        writes.push({ path: `${kbDirName}/${file.repoPath}`, content: file.content });
      }
      writes.push({
        path: `${kbDirName}/${root}/access.md`,
        content: shippedAccess ? withCreatorGrants(shippedAccess, user) : pluginAccessMd(user),
      });
      if (!hasManifest) writes.push({ path: `${kbDirName}/${root}/${PLUGIN_MANIFEST_FILE}`, content: renderPluginManifest(folder) });
    }
    return writes;
  }
}

function alreadyChosen(): StarterPackError {
  return new StarterPackError('Starter pages were already chosen for this knowledge base.', 409);
}

/** The commit's subject: "Add starter pages and skills for Sales". */
export function commitSubjectOf(pack: Pick<StarterPack, 'id' | 'name'>): string {
  return pack.id === CATCH_ALL_PACK ? 'Add starter pages and skills' : `Add starter pages and skills for ${pack.name}`;
}

/** "Added 4 pages and 1 skill for Sales." */
export function summaryOf(pack: Pick<StarterPack, 'id' | 'name'>, pages: number, skills: number): string {
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const parts = [pages > 0 ? count(pages, 'page') : null, skills > 0 ? count(skills, 'skill') : null].filter(Boolean);
  if (parts.length === 0) return 'Everything in this pack was already here.';
  return `Added ${parts.join(' and ')}${pack.id === CATCH_ALL_PACK ? '' : ` for ${pack.name}`}.`;
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs);
    return true;
  } catch {
    return false;
  }
}

/** The names in `dir`, or none when it is not there. */
async function childNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
