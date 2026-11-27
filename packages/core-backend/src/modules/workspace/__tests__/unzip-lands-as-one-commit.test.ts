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
import { creatableRootDirNames, type AuthUser, type IVersionControlService } from '@bevel-software/platform-shared';
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
import { AccessDeniedError, type CreationGrantPlan, type IChangeReadGate, type ICreatorAccess } from '../../access-model/index.js';
import type { ToolContext } from '../../tool-helpers/index.js';
import type { ToolAuth } from '../../tool-auth/index.js';
import { ToolRegistry } from '../../tool-registry/index.js';
import type { AuthService } from '../../auth/index.js';
import type { VersionControlEventBus } from '../../version-control/index.js';
import type { IAdminAccessService } from '../../admin/index.js';
import { DocExtractService, SpillStore, ToolDescriptionNotes, WorkerDocumentExtractor } from '../index.js';
import { PushNeedsAgentResolutionError } from '../../../shared/domain-errors.js';
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
 * Both doors judge an archive's entries with the one archive judge: an
 * archive's own `access.md` lands in the same commit as its files, an archive
 * carrying a `roles.yaml` or a groups file is refused whole, and when one of
 * its access rules cannot land, nothing in it lands.
 *
 * Real disk, a real repository, the real access resolver and the real
 * lock-aware filesystem. Only the version-control service is a double, over
 * the same repository, asking an acquire's gates as `acquireLock` asks them,
 * of the real resolver: on a protected branch, the write rule at HEAD, refused
 * with the eligible writers; on every branch, read-before-write against the
 * working tree, which lets through a path the person may read and one inside
 * a folder directly under a root that does not exist yet. Its lock table
 * refuses a live lock to everyone, its own holder included, as the real one
 * does; a release QUEUES the path's commit for the pending-commits worker, so
 * nothing is committed when the call returns; and `commitChanges` commits
 * exactly the paths it names, at once, as one commit.
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
  /** When set, a commit lands and its push is refused, as the real service reports it. */
  const push = { refused: false };
  const repoPath = (wsPath: string) => wsPath.slice(KB.length + 1);
  /** Read-before-write's verdict: a path the person may read, or one inside a new folder directly under a root. */
  const mayChange = async (ws: string, email: string, rel: string): Promise<boolean> => {
    const [root, folder, ...rest] = rel.split('/');
    const isNew = !(await fs.stat(path.join(repoDir, root, folder ?? '')).then(() => true, () => false));
    if (creatableRootDirNames(kb.layout).has(root) && rest.length > 0 && isNew) return true;
    return access.canRead(ws, email, rel);
  };
  /** When each held path's lock was granted, which is what tells one grant from the next. */
  const grantedAt = new Map<string, string>();
  let grants = 0;
  const vcs = {
    acquireLock: async (ws: string, onBranch: string, p: string, user: AuthUser) => {
      if (kb.isProtectedBranch(onBranch)) {
        const verdicts = await access.canWriteBatchAtRef(ws, 'HEAD', user.email, [repoPath(p)]);
        if (verdicts && verdicts.get(repoPath(p)) !== true) {
          const eligible = await access.eligibleWritersAtRef(ws, 'HEAD', repoPath(p));
          throw new AccessDeniedError({ path: p, eligibleRoles: eligible?.roles ?? [], eligibleUsers: eligible?.users ?? [] });
        }
      }
      if (!(await mayChange(ws, user.email, repoPath(p)))) {
        throw new AccessDeniedError({ path: p, eligibleRoles: [], eligibleUsers: [], unreadable: repoPath(p) });
      }
      const holder = held.get(p);
      if (holder !== undefined) return { acquired: false, lock: { holderName: holder } };
      held.set(p, user.name);
      // Each grant is its own: a path taken again is granted a later moment.
      const acquiredAt = new Date(Date.UTC(2026, 0, 1, 0, 0, (grants += 1))).toISOString();
      grantedAt.set(p, acquiredAt);
      return { acquired: true, lock: { holderName: user.name, acquiredAt } };
    },
    // A batch's ownership check: the lock the acquire granted, while it is
    // held, with the moment it was granted.
    heartbeatLock: async (_w: string, _b: string, p: string, user: AuthUser) => {
      if (held.get(p) !== user.name) throw new Error(`not held: ${p}`);
      return { holderName: user.name, acquiredAt: grantedAt.get(p) };
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
      if (push.refused) throw new PushNeedsAgentResolutionError(BRANCH, paths[0], 'rejected', 'retry later', 'refused');
      return null;
    },
  };
  return { held, queued, push, mayChange, vcs: vcs as unknown as IVersionControlService };
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
  'roles.yaml': `roles:\n  Admin:\n    - admin@x.io\n  Finance:\n    - ${FINANCE_READER}\n  CFO:\n    - ${CFO}\n  Planner:\n    - ${ANA.email}\n`,
  'access.md': '---\nread:\n  - Admin\nwrite:\n  - everyone\n---\n',
  'Finance/access.md': '---\nread:\n  - Finance\n  - CFO\n  - Planner\n---\n',
  'Finance/plan.md': '# Plan\n',
  'Finance/Sealed/access.md': '---\nread:\n  - deny everyone\n  - CFO\n---\n',
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
/** Every event the app route emitted. */
let routeEvents: { kind: string }[] = [];
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
  routeEvents = [];
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

/** No creator grant planned anywhere. */
const NO_GRANTS: ICreatorAccess = { planForCreate: async () => null, noteAccessFileWritten: () => {} };

/** The agent `unzip` tool, mounted as the platform mounts it, writing through the lock-aware filesystem. */
async function startTools(
  creatorAccess: ICreatorAccess = NO_GRANTS,
  changeGate?: IChangeReadGate,
): Promise<(body: Record<string, unknown>) => Promise<Response>> {
  const lockingFs = new LockingFilesystem(
    { basePath: workspaceDir, contained: true },
    { versionControl: lockTable.vcs, workspaceId, branch, user: ANA, kbDirName: KB, creatorAccess },
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
    undefined,
    changeGate,
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
  creatorAccess: ICreatorAccess = NO_GRANTS,
  changeGate?: IChangeReadGate,
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
      { emit: (e: { kind: string }) => void routeEvents.push(e) } as unknown as VersionControlEventBus,
      access,
      kb,
      creatorAccess,
      { isAdmin: async () => false } as unknown as IAdminAccessService,
      realDisk(),
      undefined,
      changeGate,
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

/** Read-before-write as the platform's gate answers it, by the rule the lock table's acquire asks. */
const gateOverLocks = (): IChangeReadGate => {
  const repoPath = (wsPath: string) => wsPath.slice(KB.length + 1);
  const judge: IChangeReadGate['judge'] = async (ws, email, wsPath) =>
    (await lockTable.mayChange(ws, email, repoPath(wsPath)))
      ? { allowed: true, via: 'readable' }
      : { allowed: false, unreadable: repoPath(wsPath) };
  return {
    judge,
    assertMayChange: async (ws, email, wsPath, kind) => {
      const verdict = await judge(ws, email, wsPath, kind);
      if (!verdict.allowed) {
        throw new AccessDeniedError({ path: wsPath, eligibleRoles: [], eligibleUsers: [], unreadable: verdict.unreadable, targetKind: kind });
      }
    },
  };
};

const doors = [
  ['the agent unzip tool', startTools],
  ['the app unzip route', startRoute],
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
    // The payload `PathHeldError` carries, with the extraction's own sentence.
    expect(await res.json()).toEqual({
      kind: 'path-held',
      path: `${KB}/Finance/Secret/access.md`,
      error: `"${KB}/Finance/Secret/access.md" is being edited by Bo, so nothing was extracted. Try again once they are done.`,
    });
    // The batch retries a contended lock for a few seconds before it refuses.
  }, 20_000);
});

describe.each(doors)('an archive extracted through %s whose commit lands but whose push needs resolution', (door, start) => {
  beforeEach(() => seed(BRANCH, DRAFT_TREE));

  it('answers the push\'s error, with the files committed and the directory entries created', async () => {
    const unzip = await start();
    lockTable.push.refused = true;
    const before = await commitCount();

    const res = await unzip({ path: `${KB}/Finance/drop.zip` });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Saved locally on "drop-draft"/);
    expect(await commitCount()).toBe(before + 1);
    expect(await filesOfHead()).toEqual(['Finance/Secret/Budget.xlsx', 'Finance/Secret/access.md']);
    expect(await exists('Finance/Notes')).toBe(true);
    if (door === 'the app unzip route') expect(routeEvents.map((e) => e.kind)).toContain('fs-tree-changed');
  });
});

describe.each(doors)('an archive extracted through %s into a new folder directly under a root', (_door, start) => {
  beforeEach(() => seed(BRANCH, DRAFT_TREE));

  it('lands the creator\'s grant in the same commit as the files', async () => {
    const unzip = await start(creatorAccessOver(workspaceDir));
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

describe.each(doors)('an archive extracted through %s into a folder the person cannot read', (_door, start) => {
  beforeEach(() => seed(BRANCH, DRAFT_TREE));

  it('skips the entry read-before-write refuses, with the gate\'s refusal, and lands the rest as one commit', async () => {
    const unzip = await start();
    const zip = new AdmZip();
    zip.addFile('Sealed/peek.md', Buffer.from('# Peek\n'));
    zip.addFile('open.md', Buffer.from('# Open\n'));
    await fs.writeFile(path.join(repoDir, 'Finance/mixed.zip'), zip.toBuffer());
    const before = await commitCount();

    const res = await unzip({ path: `${KB}/Finance/mixed.zip` });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { extracted: string[]; skipped: { path: string; reason: string }[] };
    expect(body.extracted).toEqual([`${KB}/Finance/open.md`]);
    expect(body.skipped).toEqual([{ path: 'Sealed/peek.md', reason: expect.stringContaining('read access to "Finance/Sealed/peek.md"') }]);
    expect(await commitCount()).toBe(before + 1);
    expect(await filesOfHead()).toEqual(['Finance/open.md']);
    expect(await exists('Finance/Sealed/peek.md')).toBe(false);
  });

  it('lands nothing when its own access.md is the entry read-before-write refuses', async () => {
    const unzip = await start();
    const zip = new AdmZip();
    zip.addFile('Sealed/access.md', Buffer.from('---\nread:\n  - everyone\n---\n'));
    zip.addFile('open.md', Buffer.from('# Open\n'));
    await fs.writeFile(path.join(repoDir, 'Finance/opener.zip'), zip.toBuffer());
    const before = await commitCount();

    const res = await unzip({ path: `${KB}/Finance/opener.zip` });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; kind: string };
    expect(body.kind).toBe('archive-refused');
    expect(body.error).toBe(
      `"${KB}/Finance/Sealed/access.md" could not land: You don't have permission to write to "${KB}/Finance/Sealed/access.md". ` +
        'You don\'t have read access to "Finance/Sealed/access.md"; only what you can read can be created, changed or removed. ' +
        "An archive's access rules land with its files or not at all, so nothing in it was landed.",
    );
    expect(await commitCount()).toBe(before);
    expect(await exists('Finance/open.md')).toBe(false);
    // Nothing on disk besides the archive the test put there.
    expect((await git(repoDir, 'status', '--porcelain', '--untracked-files=all')).trim()).toBe('?? Finance/opener.zip');
    expect(lockTable.held.size).toBe(0);
  });
});

describe.each(doors)('an archive extracted through %s: under a folder the person cannot read, the disk is never what answers', (_door, start) => {
  let elsewhere = '';
  afterEach(() => fs.rm(elsewhere, { recursive: true, force: true }));
  beforeEach(async () => {
    await seed(BRANCH, DRAFT_TREE);
    elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'unzip-elsewhere-'));
    await fs.symlink(elsewhere, path.join(repoDir, 'Finance/Sealed/link'), process.platform === 'win32' ? 'junction' : 'dir');
  });

  it('answers an entry under it the same, file or folder, whether a link is on its path or not', async () => {
    const unzip = await start(NO_GRANTS, gateOverLocks());
    const zip = new AdmZip();
    zip.addFile('Sealed/link/through.md', Buffer.from('# Through\n'));
    zip.addFile('Sealed/plain.md', Buffer.from('# Plain\n'));
    zip.addFile('Sealed/link/sub/', Buffer.alloc(0));
    zip.addFile('Sealed/fresh/', Buffer.alloc(0));
    zip.addFile('open.md', Buffer.from('# Open\n'));
    await fs.writeFile(path.join(repoDir, 'Finance/links.zip'), zip.toBuffer());

    const res = await unzip({ path: `${KB}/Finance/links.zip` });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { extracted: string[]; skipped: { path: string; reason: string }[] };
    expect(body.extracted).toEqual([`${KB}/Finance/open.md`]);
    const reasonOf = (name: string) => body.skipped.find((s) => s.path === name)?.reason ?? '';
    expect(reasonOf('Sealed/link/through.md')).toContain('read access to "Finance/Sealed/link/through.md"');
    expect(reasonOf('Sealed/link/through.md').replaceAll('link/through', 'X')).toBe(reasonOf('Sealed/plain.md').replaceAll('plain', 'X'));
    expect(reasonOf('Sealed/link/sub/')).toContain('read access to "Finance/Sealed/link/sub"');
    expect(reasonOf('Sealed/link/sub/').replaceAll('link/sub', 'X')).toBe(reasonOf('Sealed/fresh/').replaceAll('fresh', 'X'));
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  it('refuses a destination inside it whole, before looking at it: through a link or not, nothing lands and no lock is taken', async () => {
    const unzip = await start(NO_GRANTS, gateOverLocks());
    const before = await commitCount();
    for (const destination of [`${KB}/Finance/Sealed/link/out`, `${KB}/Finance/Sealed/out`]) {
      const res = await unzip({ path: `${KB}/Finance/drop.zip`, destination });
      expect(res.status, destination).toBe(403);
      const text = await res.text();
      expect(text, destination).toContain('read access to');
      expect(text, destination).not.toMatch(/traversal|Secret|Budget/i);
    }
    expect(await commitCount()).toBe(before);
    expect(await fs.readdir(elsewhere)).toEqual([]);
    expect(await exists('Finance/Sealed/out')).toBe(false);
    expect(lockTable.held.size).toBe(0);
  });

  it('refuses an archive inside it as read_file refuses it, before a byte is read: one that is no zip, or not there, is not told apart', async () => {
    await fs.writeFile(path.join(repoDir, 'Finance/Sealed/broken.zip'), Buffer.from('not a zip at all'));
    const unzip = await start(NO_GRANTS, gateOverLocks());
    for (const name of ['broken.zip', 'missing.zip', 'link/through.zip']) {
      const res = await unzip({ path: `${KB}/Finance/Sealed/${name}`, destination: `${KB}/Finance` });
      expect(res.status, name).toBe(403);
      expect(await res.json(), name).toEqual({ error: `You don't have permission to read "${KB}/Finance/Sealed/${name}".` });
    }
  });
});

describe.each(doors)('an archive extracted through %s, past its commit', (door, start) => {
  beforeEach(() => seed(BRANCH, DRAFT_TREE));

  it('answers as usual when a directory entry sits where a file already is: the files land, the entry is skipped, the tree event is sent', async () => {
    const unzip = await start();
    const zip = new AdmZip();
    zip.addFile('plan.md/', Buffer.alloc(0));
    zip.addFile('new.md', Buffer.from('# New\n'));
    await fs.writeFile(path.join(repoDir, 'Finance/folder-over-file.zip'), zip.toBuffer());
    routeEvents = [];

    const res = await unzip({ path: `${KB}/Finance/folder-over-file.zip` });

    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { extracted: string[]; skipped: { path: string; reason: string }[] };
    expect(body.extracted).toEqual([`${KB}/Finance/new.md`]);
    expect(body.skipped).toEqual([{ path: 'plan.md/', reason: 'A file is already at this path, so the folder was not created' }]);
    // No server path in the answer.
    expect(text).not.toContain(root);
    expect(await filesOfHead()).toEqual(['Finance/new.md']);
    expect(await fs.readFile(path.join(repoDir, 'Finance/plan.md'), 'utf8')).toBe('# Plan\n');
    if (door === 'the app unzip route') expect(routeEvents.map((e) => e.kind)).toContain('fs-tree-changed');
  });
});

describe.each(doors)('an archive extracted through %s that carries a .bevelignore', (_door, start) => {
  beforeEach(() => seed(BRANCH, DRAFT_TREE));

  it('lands it in the same commit as the files beside it', async () => {
    const unzip = await start();
    const zip = new AdmZip();
    zip.addFile('Team/.bevelignore', Buffer.from('drafts/\n'));
    zip.addFile('Team/page.md', Buffer.from('# Page\n'));
    await fs.writeFile(path.join(repoDir, 'Finance/team.zip'), zip.toBuffer());
    const before = await commitCount();

    const res = await unzip({ path: `${KB}/Finance/team.zip` });

    expect(res.status).toBe(200);
    expect(await commitCount()).toBe(before + 1);
    expect(await filesOfHead()).toEqual(['Finance/Team/.bevelignore', 'Finance/Team/page.md']);
  });

  it('lands nothing when its .bevelignore cannot land', async () => {
    const unzip = await start();
    const zip = new AdmZip();
    zip.addFile('Sealed/.bevelignore', Buffer.from('*\n'));
    zip.addFile('open.md', Buffer.from('# Open\n'));
    await fs.writeFile(path.join(repoDir, 'Finance/ignore.zip'), zip.toBuffer());
    const before = await commitCount();

    const res = await unzip({ path: `${KB}/Finance/ignore.zip` });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; kind: string; entry: string };
    expect(body).toMatchObject({ kind: 'archive-refused', entry: `${KB}/Finance/Sealed/.bevelignore` });
    expect(await commitCount()).toBe(before);
    expect(await exists('Finance/open.md')).toBe(false);
    expect(lockTable.held.size).toBe(0);
  });
});

describe.each(doors)('an archive the person cannot read, extracted through %s', (_door, start) => {
  beforeEach(() => seed(BRANCH, { ...DRAFT_TREE, 'Finance/Sealed/payroll.zip': secretArchive() }));

  it('is refused as read_file refuses it, into a folder they can read: nothing lands, and no entry is named', async () => {
    const unzip = await start();
    const before = await commitCount();

    const res = await unzip({ path: `${KB}/Finance/Sealed/payroll.zip`, destination: `${KB}/Finance` });

    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: `You don't have permission to read "${KB}/Finance/Sealed/payroll.zip".` });
    // Nothing the archive holds is named: not a file, not a folder.
    expect(text).not.toMatch(/Secret|Budget|access\.md|Notes/);
    expect(await commitCount()).toBe(before);
    expect((await git(repoDir, 'status', '--porcelain', '--untracked-files=all')).trim()).toBe('');
    expect(await exists('Finance/Secret')).toBe(false);
    expect(await exists('Finance/Notes')).toBe(false);
    expect(lockTable.held.size).toBe(0);
  });

  it('lands nothing when whether they may read it cannot be checked, and names no entry', async () => {
    const unzip = await start();
    const before = await commitCount();
    access.canRead = async () => {
      throw new Error('the access tree could not be read');
    };

    const res = await unzip({ path: `${KB}/Finance/Sealed/payroll.zip`, destination: `${KB}/Finance` });

    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'Whether this archive may be read could not be checked, so nothing was extracted.' });
    expect(text).not.toMatch(/Secret|Budget|access\.md|Notes/);
    expect(await commitCount()).toBe(before);
    expect((await git(repoDir, 'status', '--porcelain', '--untracked-files=all')).trim()).toBe('');
  });
});

describe.each(doors)('an archive extracted through %s that carries a file read by its fixed name at the root', (_door, start) => {
  beforeEach(() => seed(BRANCH, DRAFT_TREE));

  it.each(['roles.yaml', 'groups.yaml', 'synced-groups.yaml'])('is refused whole when it carries %s, and lands nothing', async (name) => {
    const unzip = await start();
    const zip = new AdmZip();
    zip.addFile('Finance/notes.md', Buffer.from('# Notes\n'));
    zip.addFile(name, Buffer.from('roles: {}\n'));
    await fs.writeFile(path.join(repoDir, 'Finance/root-drop.zip'), zip.toBuffer());
    const before = await commitCount();

    const res = await unzip({ path: `${KB}/Finance/root-drop.zip`, destination: KB });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      `${name} never comes from an archive: edit the file itself, where the change is checked. Nothing in the archive was landed.`,
    );
    expect(await commitCount()).toBe(before);
    expect(await exists('Finance/notes.md')).toBe(false);
    expect(lockTable.held.size).toBe(0);
  });

  it('lands a file of one of those names below the root, where the platform does not read it, as content', async () => {
    const unzip = await start();
    const zip = new AdmZip();
    zip.addFile('roles.yaml', Buffer.from('just a page\n'));
    await fs.writeFile(path.join(repoDir, 'Finance/nested.zip'), zip.toBuffer());

    const res = await unzip({ path: `${KB}/Finance/nested.zip` });

    expect(res.status).toBe(200);
    expect(await filesOfHead()).toEqual(['Finance/roles.yaml']);
  });
});

describe.each(doors)('an archive extracted through %s whose access.md cannot be read out of it', (_door, start) => {
  beforeEach(() => seed(BRANCH, DRAFT_TREE));

  it('lands nothing: the files never arrive without the rule they came with', async () => {
    const unzip = await start();
    const zip = new AdmZip();
    zip.addFile('Secret/access.md', Buffer.from('---\nread:\n  - deny everyone\n  - CFO\n---\n'));
    zip.addFile('Secret/Budget.md', Buffer.from('numbers\n'));
    const archive = zip.toBuffer();
    // Break the rule's checksum in both its headers, so the reader refuses that entry alone.
    const name = Buffer.from('Secret/access.md');
    for (const [signature, nameAt, crcAt] of [
      [[0x50, 0x4b, 0x03, 0x04], 30, 14],
      [[0x50, 0x4b, 0x01, 0x02], 46, 16],
    ] as const) {
      for (let at = archive.indexOf(Buffer.from(signature)); at !== -1; at = archive.indexOf(Buffer.from(signature), at + 4)) {
        if (archive.subarray(at + nameAt, at + nameAt + name.length).equals(name)) {
          archive.writeUInt32LE((archive.readUInt32LE(at + crcAt) ^ 0xffffffff) >>> 0, at + crcAt);
        }
      }
    }
    await fs.writeFile(path.join(repoDir, 'Finance/broken.zip'), archive);
    const before = await commitCount();

    const res = await unzip({ path: `${KB}/Finance/broken.zip` });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain(`"${KB}/Finance/Secret/access.md" could not land: Entry could not be read`);
    expect(await commitCount()).toBe(before);
    expect(await exists('Finance/Secret')).toBe(false);
  });
});

/** An archive whose entries keep the names given VERBATIM, two of one name included (`addFile` replaces a name it already has). */
function zipWithRawNames(entries: [name: string, content: string][]): Buffer {
  const zip = new AdmZip();
  entries.forEach(([name, content], i) => {
    zip.addFile(`__raw_${i}`, Buffer.from(content)).entryName = name;
  });
  return zip.toBuffer();
}

/** The unix mode a zip records for a symbolic link (`S_IFLNK | 0777`), in the high half of the external attributes. */
const LINK_ATTR = ((0o120000 | 0o777) << 16) >>> 0;

/** The skip reasons and the extracted paths of an unzip that answered 200. */
const answerOf = async (res: Response) => {
  expect(res.status).toBe(200);
  return (await res.json()) as { extracted: string[]; skipped: { path: string; reason: string }[] };
};

describe.each(doors)('an archive extracted through %s, by the plan apply_file_upload lands it by', (_door, start) => {
  beforeEach(() => seed(BRANCH, DRAFT_TREE));

  // The archive `agent-uploads.test.ts` applies too. Three files, so that
  // landing them through the real lock table stays quick; 5,000 metadata
  // entries, which the archive's order puts before them, so a cap that
  // counted the metadata would skip every file.
  it('lands 3 files beside 5,000 macOS metadata entries whole: the metadata counts toward no cap', async () => {
    const unzip = await start();
    const zip = new AdmZip();
    for (let i = 0; i < 5_000; i++) zip.addFile(`__MACOSX/Mac/._f${String(i).padStart(4, '0')}.md`, Buffer.from('junk'));
    for (let i = 0; i < 3; i++) zip.addFile(`Mac/f${i}.md`, Buffer.from(`${i}\n`));
    await fs.writeFile(path.join(repoDir, 'Finance/mac.zip'), zip.toBuffer());
    const before = await commitCount();

    const body = await answerOf(await unzip({ path: `${KB}/Finance/mac.zip` }));

    expect(body.skipped).toEqual([]);
    expect(body.extracted).toEqual([0, 1, 2].map((i) => `${KB}/Finance/Mac/f${i}.md`));
    expect(await commitCount()).toBe(before + 1);
    expect(await filesOfHead()).toEqual(['Finance/Mac/f0.md', 'Finance/Mac/f1.md', 'Finance/Mac/f2.md']);
    expect(await exists('Finance/__MACOSX')).toBe(false);
  });

  it('skips a symbolic link entry and lands the rest, and lands nothing when the link is one of its access rules', async () => {
    const unzip = await start();
    const zip = new AdmZip();
    zip.addFile('note.md', Buffer.from('../plan.md')).header.attr = LINK_ATTR;
    zip.addFile('open.md', Buffer.from('# Open\n'));
    await fs.writeFile(path.join(repoDir, 'Finance/links.zip'), zip.toBuffer());

    const body = await answerOf(await unzip({ path: `${KB}/Finance/links.zip` }));

    expect(body.extracted).toEqual([`${KB}/Finance/open.md`]);
    expect(body.skipped).toEqual([{ path: 'note.md', reason: 'Entry is a symbolic link, not a file' }]);
    expect(await exists('Finance/note.md')).toBe(false);

    const rule = new AdmZip();
    rule.addFile('Secret/access.md', Buffer.from('../access.md')).header.attr = LINK_ATTR;
    rule.addFile('Secret/Budget.md', Buffer.from('numbers\n'));
    await fs.writeFile(path.join(repoDir, 'Finance/rule-link.zip'), rule.toBuffer());
    const before = await commitCount();

    const refused = await unzip({ path: `${KB}/Finance/rule-link.zip` });

    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toContain(
      `"${KB}/Finance/Secret/access.md" could not land: Entry is a symbolic link, not a file.`,
    );
    expect(await commitCount()).toBe(before);
    expect(await exists('Finance/Secret')).toBe(false);
  });

  it('lands both entries of a path the archive carries twice in its one commit, the later bytes on disk, and lists the path twice', async () => {
    const unzip = await start();
    await fs.writeFile(path.join(repoDir, 'Finance/twice.zip'), zipWithRawNames([['dup.md', 'first\n'], ['dup.md', 'second\n']]));
    const before = await commitCount();

    const body = await answerOf(await unzip({ path: `${KB}/Finance/twice.zip` }));

    expect(body.extracted).toEqual([`${KB}/Finance/dup.md`, `${KB}/Finance/dup.md`]);
    expect(body.skipped).toEqual([]);
    expect(await commitCount()).toBe(before + 1);
    expect(await filesOfHead()).toEqual(['Finance/dup.md']);
    expect(await fs.readFile(path.join(repoDir, 'Finance/dup.md'), 'utf8')).toBe('second\n');
  });

  it('skips a directory entry at the path of a file entry, and lands the file', async () => {
    const unzip = await start();
    const zip = new AdmZip();
    zip.addFile('Doc', Buffer.from('a file\n'));
    zip.addFile('Doc/', Buffer.alloc(0));
    await fs.writeFile(path.join(repoDir, 'Finance/doc.zip'), zip.toBuffer());

    const body = await answerOf(await unzip({ path: `${KB}/Finance/doc.zip` }));

    expect(body.extracted).toEqual([`${KB}/Finance/Doc`]);
    expect(body.skipped).toEqual([{ path: 'Doc/', reason: 'Directory entry is at the path of a file in the same archive' }]);
    expect(await fs.readFile(path.join(repoDir, 'Finance/Doc'), 'utf8')).toBe('a file\n');
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

  it('skips a directory entry the person may not write, and creates no such folder', async () => {
    const unzip = await start();
    const zip = new AdmZip();
    zip.addFile('Open.md', Buffer.from('# Open\n'));
    zip.addFile('Locked/Inner/', Buffer.alloc(0));
    await fs.writeFile(path.join(repoDir, 'Finance/dirs.zip'), zip.toBuffer());

    const res = await unzip({ path: `${KB}/Finance/dirs.zip` });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { extracted: string[]; skipped: { path: string; reason: string }[] };
    expect(body.extracted).toEqual([`${KB}/Finance/Open.md`]);
    expect(body.skipped).toEqual([
      { path: 'Locked/Inner/', reason: `You don't have permission to write to "${KB}/Finance/Locked/Inner". Eligible: Admin.` },
    ]);
    expect(await exists('Finance/Locked/Inner')).toBe(false);
  });

  it('lands nothing when its own access.md is a path the person may not write', async () => {
    const unzip = await start();
    const zip = new AdmZip();
    zip.addFile('Open.md', Buffer.from('# Open\n'));
    zip.addFile('Locked/access.md', Buffer.from('---\nwrite:\n  - everyone\n---\n'));
    await fs.writeFile(path.join(repoDir, 'Finance/rewrite.zip'), zip.toBuffer());
    const before = await commitCount();

    const res = await unzip({ path: `${KB}/Finance/rewrite.zip` });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      `"${KB}/Finance/Locked/access.md" could not land: You don't have permission to write to "${KB}/Finance/Locked/access.md". Eligible: Admin. ` +
        "An archive's access rules land with its files or not at all, so nothing in it was landed.",
    );
    expect(await commitCount()).toBe(before);
    expect(await exists('Finance/Open.md')).toBe(false);
    expect(await fs.readFile(path.join(repoDir, 'Finance/Locked/access.md'), 'utf8')).toBe(PROTECTED_TREE['Finance/Locked/access.md']);
    expect(lockTable.held.size).toBe(0);
  });
});
