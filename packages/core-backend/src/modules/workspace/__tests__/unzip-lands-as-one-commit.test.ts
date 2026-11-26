import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser, IVersionControlService } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import { newWorkspaceService } from '../../../__tests__/workspace-service.js';
import {
  AccessControlService,
  RoutineWritePolicyService,
  VersionControlHooks,
  createToolHandlerFactory,
  registerWorkspaceTools,
} from '../../../__tests__/tool-wiring.js';
import { LockingFilesystem } from '../../kb-fs/index.js';
import { AccessDeniedError, type CreationGrantPlan, type ICreatorAccess } from '../../access-model/index.js';
import type { ToolContext } from '../../tool-helpers/index.js';
import type { ToolAuth } from '../../tool-auth/index.js';
import { ToolRegistry } from '../../tool-registry/index.js';
import type { AuthService } from '../../auth/index.js';
import type { VersionControlEventBus } from '../../version-control/index.js';
import type { IAdminAccessService } from '../../admin/index.js';
import { DocExtractService, SpillStore, ToolDescriptionNotes, WorkerDocumentExtractor } from '../index.js';
import type { WorkspaceService } from '../workspace.service.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';

/**
 * An archive lands as ONE commit, through both doors: the agent `unzip` tool
 * and the app's `POST /workspace/:id/unzip`. A branch's reads answer from the
 * rules of the commit its checkout stands on, so an archive whose own
 * `Secret/access.md` restricts `Secret/Budget.xlsx` must bring both into that
 * commit together; landed one file per commit, the spreadsheet was readable
 * by the parent folder's readers until the rule's own commit came.
 *
 * Real disk, a real repository, the real access resolver and the real
 * lock-aware filesystem. Only the version-control service is a double, over
 * the same repository: on a protected branch an acquire is refused to a
 * person the write rule at HEAD refuses, asked of the real resolver; its lock
 * table refuses a live lock to everyone, its own holder included, as the real
 * one does; a release QUEUES the path's commit for the pending-commits
 * worker, so nothing is committed when the call returns; and `commitChanges`
 * commits exactly the paths it names, at once, as one commit.
 */

const KB = 'knowledge-base';
const BRANCH = 'drop-draft';
const ANA: AuthUser = { id: 'u-ana', email: 'ana@x.io', name: 'Ana' };
const FINANCE_READER = 'fin@x.io';
const CFO = 'cfo@x.io';

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (
    await execFileAsync('git', ['-C', cwd, '-c', 'user.email=t@x.io', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args])
  ).stdout;

/** The version-control service's lock and commit rules, over the repository at `repoDir`. */
function versionControlOver(repoDir: string) {
  /** Live locks: path → holder's name. */
  const held = new Map<string, string>();
  /** Paths whose commit a release queued and no worker has run yet. */
  const queued: string[] = [];
  const repoPath = (wsPath: string) => wsPath.slice(KB.length + 1);
  const vcs = {
    acquireLock: async (ws: string, onBranch: string, p: string, user: AuthUser) => {
      if (kb.isProtectedBranch(onBranch)) {
        const verdicts = await access.canWriteBatchAtRef(ws, 'HEAD', user.email, [repoPath(p)]);
        if (verdicts && verdicts.get(repoPath(p)) !== true) {
          throw new AccessDeniedError({ path: p, eligibleRoles: [], eligibleUsers: [] });
        }
      }
      const holder = held.get(p);
      if (holder !== undefined) return { acquired: false, lock: { holderName: holder } };
      held.set(p, user.name);
      return { acquired: true, lock: { holderName: user.name } };
    },
    releaseLock: async (_ws: string, _branch: string, p: string) => {
      held.delete(p);
      queued.push(p);
    },
    releaseLockUntouched: async (_ws: string, _branch: string, p: string) => {
      held.delete(p);
    },
    // Resets the path to the last commit: its committed bytes back, or gone
    // when the commit has none.
    releaseLockNoCommit: async (_ws: string, _branch: string, p: string) => {
      held.delete(p);
      const tracked = (await git(repoDir, 'ls-files', '--', repoPath(p))).trim() !== '';
      if (tracked) await git(repoDir, 'checkout', 'HEAD', '--', repoPath(p));
      else await fs.rm(path.join(repoDir, repoPath(p)), { force: true });
    },
    commitChanges: async (_ws: string, _user: AuthUser, summary: string, paths: string[]) => {
      const rel = paths.map(repoPath);
      await git(repoDir, 'add', '-A', '--', ...rel);
      await git(repoDir, 'commit', '-q', '-m', summary, '--', ...rel);
      return null;
    },
  };
  return { held, queued, vcs: vcs as unknown as IVersionControlService };
}

/**
 * The creator grant the real planner makes for a creation in a folder that
 * does not exist yet directly under `KnowledgeBase/`, for a person who cannot
 * read that root (as Ana cannot here: the root's rules let only Admin read):
 * a seed of the new folder's `access.md` naming the creator. Anywhere else,
 * no plan.
 */
function creatorAccessOver(workspaceDir: string): ICreatorAccess {
  return {
    planForCreate: async (_ws, creator, wsRelPath): Promise<CreationGrantPlan | null> => {
      const m = /^knowledge-base\/KnowledgeBase\/([^/]+)\//.exec(wsRelPath);
      if (!m) return null;
      const folder = `${KB}/KnowledgeBase/${m[1]}`;
      const exists = await fs.stat(path.join(workspaceDir, folder)).then(() => true, () => false);
      if (exists) return null;
      return {
        kind: 'seed-access-md',
        wsRelPath: `${folder}/access.md`,
        apply: (current) => current || `---\nread:\n  - ${creator.name} <${creator.email}>\n---\n`,
      };
    },
    noteAccessFileWritten: () => {},
  };
}

/** The archive the scenario is about: the rule after the file it governs, as capital names sort. */
function secretArchive(): Buffer {
  const zip = new AdmZip();
  zip.addFile('Secret/Budget.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]));
  zip.addFile('Secret/access.md', Buffer.from(`---\nread:\n  - deny everyone\n  - CFO\n---\n`));
  zip.addFile('Notes/', Buffer.alloc(0));
  return zip.toBuffer();
}

/** A draft branch: no write gate, the change request is where its writes are judged. */
const DRAFT_TREE: Record<string, string | Buffer> = {
  'roles.yaml': `roles:\n  Admin:\n    - admin@x.io\n  Finance:\n    - ${FINANCE_READER}\n  CFO:\n    - ${CFO}\n`,
  'access.md': '---\nread:\n  - Admin\nwrite:\n  - everyone\n---\n',
  'Finance/access.md': '---\nread:\n  - Finance\n  - CFO\n---\n',
  'Finance/plan.md': '# Plan\n',
  'Finance/drop.zip': secretArchive(),
};

let root = '';
let branch = '';
let workspaceId = '';
let workspaceDir = '';
let repoDir = '';
let workspaceService: WorkspaceService;
let access: AccessControlService;
let lockTable: ReturnType<typeof versionControlOver>;
let servers: Server[] = [];
let extractor: WorkerDocumentExtractor | undefined;
const kb = testKbContext({ kbDirName: KB });

/** `onBranch`'s checkout holding `tree`, committed, with the services over it. */
async function seed(onBranch: string, tree: Record<string, string | Buffer>): Promise<void> {
  branch = onBranch;
  workspaceId = encodeURIComponent(onBranch);
  workspaceDir = path.join(root, workspaceId);
  repoDir = path.join(workspaceDir, KB);
  for (const [rel, content] of Object.entries(tree)) {
    await fs.mkdir(path.dirname(path.join(repoDir, rel)), { recursive: true });
    await fs.writeFile(path.join(repoDir, rel), content);
  }
  await git(repoDir, 'init', '-q', '-b', onBranch);
  await git(repoDir, 'add', '-A');
  await git(repoDir, 'commit', '-q', '-m', 'seed');
  workspaceService = newWorkspaceService(root, 'https://example.invalid/kb.git', kb, realDisk());
  await workspaceService.getWorkspacePath(workspaceId);
  access = new AccessControlService(workspaceService, KB, realDisk());
  lockTable = versionControlOver(repoDir);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'unzip-one-commit-'));
});

afterEach(async () => {
  for (const s of servers) {
    s.closeIdleConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  servers = [];
  await extractor?.close();
  extractor = undefined;
  await fs.rm(root, { recursive: true, force: true });
});

async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The agent `unzip` tool, mounted as the platform mounts it, writing through the lock-aware filesystem. */
async function startTools(): Promise<(body: Record<string, unknown>) => Promise<Response>> {
  const lockingFs = new LockingFilesystem(
    { basePath: workspaceDir, contained: true },
    { versionControl: lockTable.vcs, workspaceId, branch, user: ANA, kbDirName: KB },
  );
  const resolve = async (auth: ToolAuth, signal: AbortSignal, sessionId?: string): Promise<ToolContext> => ({
    user: ANA,
    scope: auth.scope,
    source: auth.source,
    sessionId,
    abortSignal: signal,
    workspaceService,
    versionControlService: lockTable.vcs,
    events: {} as never,
    getFilesystem: async () => lockingFs,
    getWriteValidator: async () => async () => undefined,
  });
  const router = express.Router();
  extractor = new WorkerDocumentExtractor();
  registerWorkspaceTools(
    new ToolRegistry(),
    router,
    (req, _res, next) => {
      req.toolAuth = { source: 'internal', userId: ANA.id, scope: 'write' };
      next();
    },
    createToolHandlerFactory(resolve),
    new SpillStore(path.join(root, 'spills')),
    new DocExtractService(path.join(root, 'doc-cache'), extractor),
    access,
    kb,
    { recoveryBotEmail: 'recovery-bot@bevel.local', hooks: new VersionControlHooks(), notes: new ToolDescriptionNotes() },
    new RoutineWritePolicyService(),
    {} as never,
  );
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const base = await listen(app);
  return (body) =>
    fetch(`${base}/api/agent/tools/unzip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch, ...body }),
    });
}

/** The app's unzip route, as the app mounts it. */
async function startRoute(
  creatorAccess: ICreatorAccess = { planForCreate: async () => null, noteAccessFileWritten: () => {} },
): Promise<(body: Record<string, unknown>) => Promise<Response>> {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = ANA.id;
    next();
  });
  app.use(
    '/api',
    createWorkspaceRoutes(
      workspaceService,
      { getUserById: async () => ANA } as unknown as AuthService,
      lockTable.vcs,
      { emit: () => {} } as unknown as VersionControlEventBus,
      access,
      kb,
      creatorAccess,
      { isAdmin: async () => false } as unknown as IAdminAccessService,
      realDisk(),
    ),
  );
  const base = await listen(app);
  return (body) =>
    fetch(`${base}/api/workspace/${workspaceId}/unzip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
}

const commitCount = async (): Promise<number> => Number((await git(repoDir, 'rev-list', '--count', 'HEAD')).trim());
const filesOfHead = async (): Promise<string[]> =>
  (await git(repoDir, 'show', '--name-only', '--format=', 'HEAD')).trim().split('\n').sort();
const exists = (rel: string) => fs.stat(path.join(repoDir, rel)).then(() => true, () => false);

const doors = [
  ['the agent unzip tool', startTools],
  ['the app unzip route', () => startRoute()],
] as const;

describe.each(doors)('an archive extracted through %s', (_door, start) => {
  beforeEach(() => seed(BRANCH, DRAFT_TREE));

  it('is governed by its own access.md once the call returns: the parent folder\'s readers cannot read what it closes', async () => {
    const unzip = await start();

    const res = await unzip({ path: `${KB}/Finance/drop.zip` });

    expect(res.status).toBe(200);
    expect(await access.canRead(workspaceId, FINANCE_READER, 'Finance/Secret/Budget.xlsx')).toBe(false);
    // The rule's own reader can, and the parent folder stays readable.
    expect(await access.canRead(workspaceId, CFO, 'Finance/Secret/Budget.xlsx')).toBe(true);
    expect(await access.canRead(workspaceId, FINANCE_READER, 'Finance/plan.md')).toBe(true);
  });

  it('lands as one commit holding every file it extracted, and creates its directory entries', async () => {
    const unzip = await start();
    const before = await commitCount();

    const res = await unzip({ path: `${KB}/Finance/drop.zip` });

    expect(res.status).toBe(200);
    expect(await commitCount()).toBe(before + 1);
    expect(await filesOfHead()).toEqual(['Finance/Secret/Budget.xlsx', 'Finance/Secret/access.md']);
    const body = (await res.json()) as { extracted: string[] };
    expect(body.extracted.sort()).toEqual([`${KB}/Finance/Secret/Budget.xlsx`, `${KB}/Finance/Secret/access.md`]);
    // Nothing is left to a worker: no release queued a commit, and no lock is held.
    expect(lockTable.queued).toEqual([]);
    expect(lockTable.held.size).toBe(0);
    expect(await exists('Finance/Notes')).toBe(true);
  });

  it('refuses the whole extraction when someone else holds one of its paths, and writes nothing', async () => {
    const unzip = await start();
    const before = await commitCount();
    lockTable.held.set(`${KB}/Finance/Secret/access.md`, 'Bo');

    const res = await unzip({ path: `${KB}/Finance/drop.zip` });

    expect(res.status).toBe(409);
    expect((await git(repoDir, 'status', '--porcelain', '--untracked-files=all')).trim()).toBe('');
    expect(await exists('Finance/Secret')).toBe(false);
    expect(await exists('Finance/Notes')).toBe(false);
    expect(await commitCount()).toBe(before);
    // Bo's lock is still Bo's; every lock the extraction took went back.
    expect([...lockTable.held]).toEqual([[`${KB}/Finance/Secret/access.md`, 'Bo']]);
    expect(((await res.json()) as { error: string }).error).toBe(
      `"${KB}/Finance/Secret/access.md" is being edited by Bo, so nothing was extracted. Try again once they are done.`,
    );
    // The batch retries a contended lock for a few seconds before it refuses.
  }, 20_000);
});

describe('the app unzip route into a new folder directly under a root', () => {
  beforeEach(() => seed(BRANCH, DRAFT_TREE));

  it('lands the creator\'s grant in the same commit as the files', async () => {
    const unzip = await startRoute(creatorAccessOver(workspaceDir));
    const zip = new AdmZip();
    zip.addFile('a.md', Buffer.from('# A\n'));
    await fs.writeFile(path.join(repoDir, 'drop.zip'), zip.toBuffer());
    const before = await commitCount();

    const res = await unzip({ path: `${KB}/drop.zip`, destination: `${KB}/KnowledgeBase/Fresh` });

    expect(res.status).toBe(200);
    expect(await commitCount()).toBe(before + 1);
    expect(await filesOfHead()).toEqual(['KnowledgeBase/Fresh/a.md', 'KnowledgeBase/Fresh/access.md']);
    expect(await fs.readFile(path.join(repoDir, 'KnowledgeBase/Fresh/access.md'), 'utf8')).toBe(
      `---\nread:\n  - Ana <${ANA.email}>\n---\n`,
    );
  });
});

/** A protected branch, where every path the extraction writes meets the write rule at HEAD. */
const PROTECTED = 'target-company-state';
const PROTECTED_TREE: Record<string, string | Buffer> = {
  'roles.yaml': `roles:\n  Admin:\n    - admin@x.io\n  Finance:\n    - ${ANA.email}\n`,
  'access.md': '---\nread:\n  - everyone\nwrite:\n  - Admin\n---\n',
  'Finance/access.md': '---\nwrite:\n  - Finance\n---\n',
  'Finance/Locked/access.md': '---\nwrite:\n  - deny everyone\n  - Admin\n---\n',
};

describe.each(doors)('an archive extracted through %s on a protected branch', (_door, start) => {
  beforeEach(async () => {
    const zip = new AdmZip();
    zip.addFile('Open.md', Buffer.from('# Open\n'));
    zip.addFile('Locked/note.md', Buffer.from('# Note\n'));
    await seed(PROTECTED, { ...PROTECTED_TREE, 'Finance/drop.zip': zip.toBuffer() });
  });

  it('skips an entry the person may not write, with the write gate\'s refusal, and lands the rest as one commit', async () => {
    const unzip = await start();
    const before = await commitCount();

    const res = await unzip({ path: `${KB}/Finance/drop.zip` });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { extracted: string[]; skipped: { path: string; reason: string }[] };
    expect(body.extracted).toEqual([`${KB}/Finance/Open.md`]);
    expect(body.skipped).toEqual([
      { path: 'Locked/note.md', reason: `You don't have permission to write to "${KB}/Finance/Locked/note.md". Eligible: Admin.` },
    ]);
    expect(await commitCount()).toBe(before + 1);
    expect(await filesOfHead()).toEqual(['Finance/Open.md']);
    expect(await exists('Finance/Locked/note.md')).toBe(false);
  });
});
