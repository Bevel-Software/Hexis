import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { AuthUser } from '@bevel-software/platform-shared';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../__tests__/pg-scratch.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import { newWorkspaceService } from '../../../__tests__/workspace-service.js';
import { setLogger } from '../../../shared/logging.js';
import type { ILogger } from '../../../shared/logger.contract.js';
import type { IGitRunner } from '../../../shared/git.contract.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { Database } from '../../database/index.js';
import { pendingCommits } from '../../database/index.js';
import type { IAccessControl } from '../../access/index.js';
import type { WorkspaceService } from '../../workspace/index.js';
import { GitService } from '../git/git.service.js';
import { NodeGitRunner } from '../git/node-git-runner.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IChangeRequestReviewService } from '../change-request-review/change-request-review.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import { PendingCommitsService } from '../pending-commits.service.js';
import { PendingCommitsWorker } from '../pending-commits.worker.js';
import { VersionControlHooks } from '../version-control-hooks.js';
import { VersionControlService } from '../version-control.service.js';
import { runGit } from '../git/__tests__/git-test-helpers.js';

/**
 * A save the worker gave up on (`needs_attention`) is cleared once nothing of
 * it is left to push, and only then. Everything here is real: a Postgres
 * scratch database holds the queue, the clones are real git working copies of
 * a bare "shared repository", and the service is driven through its public
 * entry points (`mergeBranch`, `updateBranch`, `clearEscalatedCommits`). The
 * clock is the row's `queued_at`, written as the 3 November incident had it.
 */

const MAIN = 'target-company-state';
const DRAFT = 'alice/draft';
const alice: AuthUser = { id: 'u-alice', email: 'alice@example.com', name: 'Alice' };
const KB = 'knowledge-base';
const NOV_2 = new Date('2026-11-02T13:28:00.000Z');

interface World {
  root: string;
  upstream: string;
  /** Working copy of each workspace id. */
  repo: (workspaceId: string) => string;
  db: Database;
  queue: PendingCommitsService;
  git: GitService;
  svc: VersionControlService;
  /** Every git invocation, with the working copy it ran in. */
  gitCalls: Array<{ cwd: string; args: string[] }>;
  logs: string[];
}

const opened: Array<() => Promise<void>> = [];
let world: World;
let restoreLogger: (() => void) | null = null;

async function makeWorld(): Promise<World> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hexis-stuck-saves-'));
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', MAIN, upstream]);
  const seed = path.join(root, 'seed');
  await fs.mkdir(seed);
  await runGit(seed, ['init', '-b', MAIN]);
  await runGit(seed, ['remote', 'add', 'origin', upstream]);
  await fs.mkdir(path.join(seed, 'Data/QA'), { recursive: true });
  for (const name of ['a', 'b', 'clean', 'dirty', 'local', 'Moved']) {
    await fs.writeFile(path.join(seed, `Data/QA/${name}.md`), `# ${name}\n`);
  }
  await runGit(seed, ['add', '.']);
  await runGit(seed, ['commit', '-m', 'seed']);
  await runGit(seed, ['push', 'origin', MAIN]);
  await runGit(seed, ['push', 'origin', `${MAIN}:${DRAFT}`]);
  await runGit(upstream, ['symbolic-ref', 'HEAD', `refs/heads/${MAIN}`]);

  const workspaceRoot = path.join(root, 'workspaces');
  const repo = (workspaceId: string) => path.join(workspaceRoot, workspaceId, KB);
  for (const branch of [MAIN, DRAFT]) {
    const dir = repo(workspaceIdForBranch(branch));
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await runGit(root, ['clone', '-b', branch, upstream, dir]);
    await runGit(dir, ['config', 'user.email', 'workspace@bevel.test']);
    await runGit(dir, ['config', 'user.name', 'Workspace']);
  }

  // Where a workspace's files are is the real service's answer over the same folders: absence only, never a failed read,
  // and a set-aside copy (under `<root>/replaced-working-copies`, the default beside the workspaces root) counts.
  const realWorkspaces = newWorkspaceService(workspaceRoot, upstream, testKbContext(), realDisk());
  const workspaces = {
    workingCopyOf: (id: string) => realWorkspaces.workingCopyOf(id),
    getWorkspacePath: async (id: string) => path.join(workspaceRoot, id),
    hasBootstrappedWorkspace: async (id: string) =>
      fs.stat(path.join(repo(id), '.git')).then(() => true, () => false),
    getOrCreateForBranch: async (branch: string) => ({ id: workspaceIdForBranch(branch) }),
    knownWorkspaces: () => [MAIN, DRAFT].map((branch) => ({ id: workspaceIdForBranch(branch), branch })),
  } as unknown as WorkspaceService;
  // Reads of anything under `Private/` are refused; everything else is open.
  const accessControl = {
    canReadBatch: vi.fn(async (_ws: string, _email: string, paths: string[]) =>
      new Map(paths.map((p) => [p, !p.startsWith('Private/')])),
    ),
  } as unknown as IAccessControl;

  const gitCalls: World['gitCalls'] = [];
  const inner = new NodeGitRunner();
  const runner: IGitRunner = {
    run: ((cwd: string, args: string[], opts?: unknown) => {
      gitCalls.push({ cwd, args });
      return (inner.run as (c: string, a: string[], o?: unknown) => unknown)(cwd, args, opts);
    }) as IGitRunner['run'],
  };
  const kb = testKbContext();
  const git = new GitService(workspaces, new VersionControlHooks(), kb, undefined, null, runner);

  const { db, close } = await openMigratedScratchDb('hexis_stuck_saves');
  opened.push(close);
  const queue = new PendingCommitsService(db);
  const svc = new VersionControlService(
    db,
    git,
    { listOpenPrs: async () => [] } as unknown as PullRequestService,
    {} as IChangeRequestReviewService,
    workspaces,
    accessControl,
    {} as FileLockService,
    queue,
    kb,
    openChangeGate(),
  );
  svc.mergeWaitForPendingCommits = { timeoutMs: 300, pollMs: 20 };

  const logs: string[] = [];
  const capture = (): ILogger => ({
    debug: () => {},
    info: (message) => void logs.push(message),
    warn: (message) => void logs.push(message),
    error: (message) => void logs.push(message),
    child: () => capture(),
  });
  const previous = setLogger(capture());
  restoreLogger = () => setLogger(previous);

  return { root, upstream, repo, db, queue, git, svc, gitCalls, logs };
}

/** A row the worker escalated, as the 3 November ones were: two tries, three recovery runs. */
async function stuckRow(
  w: World,
  over: { path: string; branch?: string; workspaceId?: string; queuedAt?: Date; status?: string },
): Promise<string> {
  const branch = over.branch ?? MAIN;
  const [row] = await w.db
    .insert(pendingCommits)
    .values({
      workspaceId: over.workspaceId ?? workspaceIdForBranch(branch),
      branch,
      path: over.path,
      authorEmail: alice.email,
      authorEmailBidx: alice.email,
      authorName: alice.name,
      queuedAt: over.queuedAt ?? NOV_2,
      status: over.status ?? 'needs_attention',
      attempts: 2,
      recoveryAgentRuns: 3,
      lastAttemptedAt: new Date('2026-11-03T22:41:00.000Z'),
      lastError: '422 the repository host refused the push',
    })
    .returning({ id: pendingCommits.id });
  return row.id;
}

async function rowsLeft(w: World): Promise<Array<{ path: string; status: string }>> {
  return (await w.db.select({ path: pendingCommits.path, status: pendingCommits.status }).from(pendingCommits))
    .sort((x, y) => x.path.localeCompare(y.path) || x.status.localeCompare(y.status));
}

/** A later save that a person made and the worker landed: committed and pushed from the main working copy. */
async function laterSave(w: World, name: string, body: string | null): Promise<void> {
  const dir = w.repo(MAIN);
  const file = path.join(dir, 'Data/QA', name);
  if (body === null) await runGit(dir, ['rm', '-q', `Data/QA/${name}`]);
  else await fs.writeFile(file, body);
  await runGit(dir, ['add', '-A']);
  await runGit(dir, ['commit', '-m', `save ${name}`]);
  await runGit(dir, ['push', 'origin', MAIN]);
}

/**
 * The person saves `Data/QA/<name>` on MAIN again: new bytes on disk and a queued row, as a lock release leaves
 * them, and the real worker commits and pushes it. Answers the worker's notice sink.
 */
async function saveAgain(w: World, name: string, body: string): Promise<ReturnType<typeof vi.fn>> {
  const mainWs = workspaceIdForBranch(MAIN);
  await fs.writeFile(path.join(w.repo(MAIN), 'Data/QA', name), body);
  await w.queue.enqueue({ workspaceId: mainWs, branch: MAIN, path: `${KB}/Data/QA/${name}`, authorEmail: alice.email, authorName: alice.name });
  const notify = vi.fn();
  const worker = new PendingCommitsWorker({
    service: w.queue,
    versionControl: w.svc,
    recoveryAgent: { run: vi.fn() } as never,
    feedback: { notify } as never,
    workspaces: { knownWorkspaces: () => [{ id: mainWs, branch: MAIN }] },
    recoveryBot: { id: 'bot', email: 'bot@example.com', name: 'Bot' },
  });
  worker.start();
  try {
    await vi.waitFor(async () => expect((await rowsLeft(w)).filter((r) => r.status !== 'needs_attention')).toEqual([]), {
      timeout: 20_000,
      interval: 100,
    });
  } finally {
    await worker.stop();
  }
  return notify;
}

describe.skipIf(!PG_ADMIN_URL)('stuck saves clear themselves once nothing of them is left to push', () => {
  beforeEach(async () => {
    world = await makeWorld();
  }, PG_TEST_TIMEOUT);

  afterEach(async () => {
    restoreLogger?.();
    restoreLogger = null;
    await fs.rm(world.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  afterAll(async () => {
    for (const close of opened) await close();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  it(
    'the 3 November state: rows for files later saves pushed, and one for a file since moved away, no longer block the merge',
    async () => {
      const w = world;
      // Two files saved again and pushed since their rows were escalated, one moved away (deleted and pushed).
      await laterSave(w, 'a.md', '# a, saved again\n');
      await laterSave(w, 'b.md', '# b, saved again\n');
      await laterSave(w, 'Moved.md', null);
      // Many rows, as production had (422 rows for 353 files): repeated saves of the same files.
      for (let i = 0; i < 20; i++) {
        await stuckRow(w, { path: `${KB}/Data/QA/a.md`, queuedAt: new Date(NOV_2.getTime() + i * 60_000) });
        await stuckRow(w, { path: `${KB}/Data/QA/b.md`, queuedAt: new Date(NOV_2.getTime() + i * 60_000) });
      }
      await stuckRow(w, { path: `${KB}/Data/QA/Moved.md` });
      w.gitCalls.length = 0;

      const outcome = await w.svc.mergeBranch(alice, MAIN, DRAFT);

      expect(outcome).toMatchObject({ kind: 'merged' });
      expect(await rowsLeft(w)).toEqual([]);
      // The check costs a handful of git calls in the working copy, not one per row.
      const inMain = w.gitCalls.filter((c) => c.cwd === w.repo(MAIN));
      expect(inMain.filter((c) => c.args[0] === 'fetch')).toHaveLength(1);
      expect(inMain.length).toBeLessThanOrEqual(12);
      // One log line per removal: the branch, the path and when it was queued.
      const cleared = w.logs.filter((l) => l.startsWith('cleared a stuck save'));
      expect(cleared).toHaveLength(41);
      expect(cleared).toContain(
        `cleared a stuck save with nothing left to push: branch="${MAIN}" path="${KB}/Data/QA/Moved.md" queued=${NOV_2.toISOString()}`,
      );
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'keeps a row whose change is missing, removes the rest, and refuses naming only what is kept',
    async () => {
      const w = world;
      const dir = w.repo(MAIN);
      // Changed on disk, never committed.
      await fs.writeFile(path.join(dir, 'Data/QA/dirty.md'), '# dirty, unsaved change\n');
      // Committed in the working copy, never pushed.
      await fs.writeFile(path.join(dir, 'Data/QA/local.md'), '# local, committed only here\n');
      await runGit(dir, ['commit', '-m', 'local only', '--', 'Data/QA/local.md']);
      // Added on disk, never committed (absent from the last commit, present here).
      await fs.writeFile(path.join(dir, 'Data/QA/new.md'), '# new\n');
      for (const name of ['clean', 'dirty', 'local', 'new']) await stuckRow(w, { path: `${KB}/Data/QA/${name}.md` });

      const outcome = await w.svc.mergeBranch(alice, MAIN, DRAFT);

      expect(outcome).toMatchObject({
        kind: 'pending-commits',
        branch: MAIN,
        pending: 3,
        needsAttention: '422 the repository host refused the push',
        stuck: { files: [`${KB}/Data/QA/dirty.md`, `${KB}/Data/QA/local.md`, `${KB}/Data/QA/new.md`], more: 0 },
      });
      expect((outcome as { message: string }).message).toMatch(/Nothing was merged\. Tell the user: saving each file in `stuck` again lands it, then merge again\./);
      expect((await rowsLeft(w)).map((r) => r.path)).toEqual([
        `${KB}/Data/QA/dirty.md`,
        `${KB}/Data/QA/local.md`,
        `${KB}/Data/QA/new.md`,
      ]);
      expect(w.logs.filter((l) => l.startsWith('cleared a stuck save'))).toEqual([
        `cleared a stuck save with nothing left to push: branch="${MAIN}" path="${KB}/Data/QA/clean.md" queued=${NOV_2.toISOString()}`,
      ]);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'keeps a row for a staged rename\'s old name, for bytes beside the clone, and for a path that is not a valid one',
    async () => {
      const w = world;
      const dir = w.repo(MAIN);
      // Renamed in the index, not committed: the old name is gone here and still in the last commit.
      await runGit(dir, ['mv', 'Data/QA/a.md', 'Data/QA/a-renamed.md']);
      // A save that named a path without the clone folder: its bytes sit beside the clone, where git never looks.
      await fs.writeFile(path.join(path.dirname(dir), 'stray.md'), 'beside the clone\n');
      for (const p of [`${KB}/Data/QA/a.md`, 'stray.md', `${KB}/../escape.md`]) await stuckRow(w, { path: p });

      expect(await w.svc.mergeBranch(alice, MAIN, DRAFT)).toMatchObject({ kind: 'pending-commits', pending: 3 });
      expect((await rowsLeft(w)).map((r) => r.path).sort()).toEqual([`${KB}/../escape.md`, `${KB}/Data/QA/a.md`, 'stray.md'].sort());
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'keeps every row when the repository cannot be reached, and refuses as before',
    async () => {
      const w = world;
      await laterSave(w, 'a.md', '# a, saved again\n');
      await stuckRow(w, { path: `${KB}/Data/QA/a.md` });
      // The shared repository is gone from where the working copy fetches it.
      await runGit(w.repo(MAIN), ['remote', 'set-url', 'origin', path.join(w.root, 'nowhere.git')]);

      const outcome = await w.svc.mergeBranch(alice, MAIN, DRAFT);

      expect(outcome).toMatchObject({ kind: 'pending-commits', pending: 1, stuck: { files: [`${KB}/Data/QA/a.md`], more: 0 } });
      expect(await rowsLeft(w)).toEqual([{ path: `${KB}/Data/QA/a.md`, status: 'needs_attention' }]);
      expect(w.logs.some((l) => l.startsWith('could not check 1 stuck save(s)'))).toBe(true);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'keeps every row when the working copy has another branch checked out than the row names',
    async () => {
      const w = world;
      await runGit(w.repo(MAIN), ['checkout', '-q', '-b', 'elsewhere']);
      await stuckRow(w, { path: `${KB}/Data/QA/clean.md` });
      expect(await w.svc.mergeBranch(alice, MAIN, DRAFT)).toMatchObject({ kind: 'pending-commits', pending: 1 });
      expect(await rowsLeft(w)).toHaveLength(1);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'removes a row whose working copy no longer exists, in place or set aside',
    async () => {
      const w = world;
      await stuckRow(w, { path: `${KB}/Data/QA/a.md`, workspaceId: 'a-deleted-branch' });
      expect(await w.svc.mergeBranch(alice, MAIN, DRAFT)).toMatchObject({ kind: 'nothing-to-merge' });
      expect(await rowsLeft(w)).toEqual([]);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'keeps a row whose working copy was set aside when the repository was replaced, and refuses as before',
    async () => {
      const w = world;
      // Where a set-aside puts a working copy: <set-aside root>/<stamp>/<workspace id>. Its folder under the workspaces root is gone.
      await fs.mkdir(path.join(w.root, 'replaced-working-copies', '2026-11-03T10-00-00-000Z', 'replaced', '.git'), { recursive: true });
      await stuckRow(w, { path: `${KB}/Data/QA/a.md`, workspaceId: 'replaced' });
      expect(await w.svc.mergeBranch(alice, MAIN, DRAFT)).toMatchObject({ kind: 'pending-commits', pending: 1 });
      await w.svc.clearEscalatedCommits();
      expect(await rowsLeft(w)).toEqual([{ path: `${KB}/Data/QA/a.md`, status: 'needs_attention' }]);
      expect(w.logs.filter((l) => l.startsWith('kept 1 stuck save(s)'))).toHaveLength(2);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'keeps a settled row of a workspace that was set aside, though a fresh working copy is back in its place',
    async () => {
      const w = world;
      // Settled in the live working copy: without the set-aside copy this row would clear (the first test).
      await laterSave(w, 'a.md', '# a, saved again\n');
      await stuckRow(w, { path: `${KB}/Data/QA/a.md` });
      // The copy that was set aside may still hold the bytes the row was escalated for.
      await fs.mkdir(path.join(w.root, 'replaced-working-copies', '2026-11-03T10-00-00-000Z', workspaceIdForBranch(MAIN), '.git'), { recursive: true });
      expect(await w.svc.mergeBranch(alice, MAIN, DRAFT)).toMatchObject({ kind: 'pending-commits', pending: 1 });
      expect(await rowsLeft(w)).toEqual([{ path: `${KB}/Data/QA/a.md`, status: 'needs_attention' }]);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'a row of a workspace that was set aside clears once its file is saved again and that save lands; later rows stay',
    async () => {
      const w = world;
      await fs.mkdir(path.join(w.root, 'replaced-working-copies', '2026-11-03T10-00-00-000Z', workspaceIdForBranch(MAIN), '.git'), { recursive: true });
      await stuckRow(w, { path: `${KB}/Data/QA/a.md` });
      // Escalated after the save below was queued: that save does not stand for it.
      const later = await stuckRow(w, { path: `${KB}/Data/QA/a.md`, queuedAt: new Date('2099-01-01T00:00:00.000Z') });
      await stuckRow(w, { path: `${KB}/Data/QA/b.md` });
      expect(await w.svc.mergeBranch(alice, MAIN, DRAFT)).toMatchObject({
        kind: 'pending-commits',
        stuck: { files: [`${KB}/Data/QA/a.md`, `${KB}/Data/QA/b.md`], more: 0 },
      });

      const notify = await saveAgain(w, 'a.md', '# a, saved again after the replacement\n');

      expect((await w.db.select({ id: pendingCommits.id, path: pendingCommits.path }).from(pendingCommits)).sort((x, y) => x.path.localeCompare(y.path)))
        .toEqual([{ id: later, path: `${KB}/Data/QA/a.md` }, { id: expect.any(String), path: `${KB}/Data/QA/b.md` }]);
      expect(w.logs).toContain(
        `cleared a stuck save, saved again since: branch="${MAIN}" path="${KB}/Data/QA/a.md" queued=${NOV_2.toISOString()}`,
      );
      expect(notify).not.toHaveBeenCalled();

      // Saved again too, the last ones go, and the merge goes through.
      await w.db.delete(pendingCommits).where(eq(pendingCommits.id, later));
      await saveAgain(w, 'b.md', '# b, saved again after the replacement\n');
      expect(await rowsLeft(w)).toEqual([]);
      expect(await w.svc.mergeBranch(alice, MAIN, DRAFT)).toMatchObject({ kind: 'merged' });
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'keeps a settled row when its working copy is set aside while it is checked',
    async () => {
      const w = world;
      await laterSave(w, 'a.md', '# a, saved again\n');
      await stuckRow(w, { path: `${KB}/Data/QA/a.md` });
      // A replacement lands during the git check: the copy is set aside (a fresh clone takes its place).
      const check = w.git.unpublishedPaths.bind(w.git);
      vi.spyOn(w.git, 'unpublishedPaths').mockImplementation(async (...args) => {
        const answer = await check(...args);
        await fs.mkdir(path.join(w.root, 'replaced-working-copies', '2026-11-24T10-00-00-000Z', workspaceIdForBranch(MAIN), '.git'), { recursive: true });
        return answer;
      });
      expect(await w.svc.mergeBranch(alice, MAIN, DRAFT)).toMatchObject({ kind: 'pending-commits', pending: 1 });
      expect(await rowsLeft(w)).toEqual([{ path: `${KB}/Data/QA/a.md`, status: 'needs_attention' }]);
      expect(w.logs.some((l) => l.startsWith('could not check 1 stuck save(s)'))).toBe(true);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'keeps the rows and refuses within the merge\'s wait when the git check does not answer in time',
    async () => {
      const w = world;
      await laterSave(w, 'a.md', '# a, saved again\n');
      await stuckRow(w, { path: `${KB}/Data/QA/a.md` });
      // A fetch that hangs: the check never answers.
      vi.spyOn(w.git, 'unpublishedPaths').mockImplementation(() => new Promise(() => {}));
      w.svc.mergeWaitForPendingCommits = { timeoutMs: 500, pollMs: 20 };
      const started = Date.now();
      expect(await w.svc.mergeBranch(alice, MAIN, DRAFT)).toMatchObject({ kind: 'pending-commits', pending: 1 });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await rowsLeft(w)).toEqual([{ path: `${KB}/Data/QA/a.md`, status: 'needs_attention' }]);
      expect(w.logs.some((l) => l.startsWith('could not check 1 stuck save(s)'))).toBe(true);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'keeps a row whose workspace folder is there but holds no working copy, and refuses as before',
    async () => {
      const w = world;
      // Half-built: the folder exists, its checkout does not. Not shown absent, so not removed.
      await fs.mkdir(path.join(w.root, 'workspaces', 'half-built'));
      await stuckRow(w, { path: `${KB}/Data/QA/a.md`, workspaceId: 'half-built' });
      expect(await w.svc.mergeBranch(alice, MAIN, DRAFT)).toMatchObject({ kind: 'pending-commits', pending: 1 });
      expect(await rowsLeft(w)).toEqual([{ path: `${KB}/Data/QA/a.md`, status: 'needs_attention' }]);
      expect(w.logs.some((l) => l.startsWith('could not check 1 stuck save(s)'))).toBe(true);
    },
    PG_TEST_TIMEOUT,
  );

  // Root reads through any mode, and Windows does not enforce POSIX modes, so
  // the refused read cannot be staged for either.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps a row whose workspace folder cannot be read: a failed read is not absence',
    async () => {
      const w = world;
      const folder = path.join(w.root, 'workspaces', 'unreadable');
      await fs.mkdir(path.join(folder, KB, '.git'), { recursive: true });
      await fs.chmod(folder, 0o000);
      try {
        await stuckRow(w, { path: `${KB}/Data/QA/a.md`, workspaceId: 'unreadable' });
        expect(await w.svc.mergeBranch(alice, MAIN, DRAFT)).toMatchObject({ kind: 'pending-commits', pending: 1 });
        await w.svc.clearEscalatedCommits();
        expect(await rowsLeft(w)).toEqual([{ path: `${KB}/Data/QA/a.md`, status: 'needs_attention' }]);
        expect(w.logs.filter((l) => l.startsWith('could not check 1 stuck save(s)'))).toHaveLength(2);
      } finally {
        await fs.chmod(folder, 0o755);
      }
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'a stuck row, a new save of the same file landing as an ordinary save, then a merge that succeeds',
    async () => {
      const w = world;
      await fs.writeFile(path.join(w.repo(MAIN), 'Data/QA/dirty.md'), '# dirty, the change that never landed\n');
      await stuckRow(w, { path: `${KB}/Data/QA/dirty.md` });
      expect(await w.svc.mergeBranch(alice, MAIN, DRAFT)).toMatchObject({
        kind: 'pending-commits',
        stuck: { files: [`${KB}/Data/QA/dirty.md`], more: 0 },
      });

      const notify = await saveAgain(w, 'dirty.md', '# dirty, saved again\n');

      expect(await w.svc.mergeBranch(alice, MAIN, DRAFT)).toMatchObject({ kind: 'merged' });
      expect(await rowsLeft(w)).toEqual([]);
      // Clearing the old row sent nobody a notice.
      expect(notify).not.toHaveBeenCalled();
      const draftFile = await fs.readFile(path.join(w.repo(workspaceIdForBranch(DRAFT)), 'Data/QA/dirty.md'), 'utf8');
      expect(draftFile).toBe('# dirty, saved again\n');
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'names at most ten files the caller may read, and counts the others without naming them',
    async () => {
      const w = world;
      const dir = w.repo(MAIN);
      // Twelve stuck files, four of them under a folder the caller may not read.
      const names = [
        ...Array.from({ length: 8 }, (_, i) => `Data/QA/open-${i}.md`),
        ...Array.from({ length: 4 }, (_, i) => `Private/secret-${i}.md`),
      ];
      await fs.mkdir(path.join(dir, 'Private'), { recursive: true });
      for (const name of names) {
        await fs.writeFile(path.join(dir, name), 'never committed\n');
        await stuckRow(w, { path: `${KB}/${name}` });
      }

      const eight = await w.svc.mergeBranch(alice, MAIN, DRAFT);
      expect(eight).toMatchObject({ kind: 'pending-commits', stuck: { more: 4 } });
      expect((eight as { stuck: { files: string[] } }).stuck.files).toEqual(names.slice(0, 8).map((n) => `${KB}/${n}`));
      expect(JSON.stringify(eight)).not.toContain('secret');

      // Past ten readable ones, the rest are counted too.
      for (let i = 8; i < 12; i++) {
        await fs.writeFile(path.join(dir, `Data/QA/open-${i}.md`), 'never committed\n');
        await stuckRow(w, { path: `${KB}/Data/QA/open-${i}.md` });
      }
      const sixteen = await w.svc.mergeBranch(alice, MAIN, DRAFT);
      expect((sixteen as { stuck: { files: string[]; more: number } }).stuck.files).toHaveLength(10);
      expect((sixteen as { stuck: { files: string[]; more: number } }).stuck.more).toBe(6);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'names none and counts one when the only stuck file is not the caller\'s to read',
    async () => {
      const w = world;
      await fs.mkdir(path.join(w.repo(MAIN), 'Private'), { recursive: true });
      await fs.writeFile(path.join(w.repo(MAIN), 'Private/secret.md'), 'never committed\n');
      await stuckRow(w, { path: `${KB}/Private/secret.md` });
      const outcome = await w.svc.mergeBranch(alice, MAIN, DRAFT);
      expect(outcome).toMatchObject({ kind: 'pending-commits', stuck: { files: [], more: 1 } });
      expect(JSON.stringify(outcome)).not.toContain('secret');
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'update_branch\'s service call clears the same rows and names the same files',
    async () => {
      const w = world;
      const draftWs = workspaceIdForBranch(DRAFT);
      await laterSave(w, 'a.md', '# a, saved again\n');
      await stuckRow(w, { path: `${KB}/Data/QA/a.md` });
      await fs.writeFile(path.join(w.repo(MAIN), 'Data/QA/dirty.md'), '# unsaved\n');
      const dirtyId = await stuckRow(w, { path: `${KB}/Data/QA/dirty.md` });

      expect(await w.svc.updateBranch(draftWs, alice, { from: MAIN })).toMatchObject({
        kind: 'pending-commits',
        branch: MAIN,
        stuck: { files: [`${KB}/Data/QA/dirty.md`], more: 0 },
        message: expect.stringContaining('then update again'),
      });
      expect((await rowsLeft(w)).map((r) => r.path)).toEqual([`${KB}/Data/QA/dirty.md`]);

      // Brought back to its committed version, the last one clears and the update goes through.
      await runGit(w.repo(MAIN), ['checkout', '--', 'Data/QA/dirty.md']);
      expect(await w.svc.updateBranch(draftWs, alice, { from: MAIN })).toMatchObject({ kind: 'merged' });
      expect(await w.db.select().from(pendingCommits).where(eq(pendingCommits.id, dirtyId))).toEqual([]);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'at startup: every branch is checked, pending and running rows are untouched, and a branch that cannot be checked keeps its rows',
    async () => {
      const w = world;
      await laterSave(w, 'a.md', '# a, saved again\n');
      await stuckRow(w, { path: `${KB}/Data/QA/a.md` });
      await stuckRow(w, { path: `${KB}/Data/QA/b.md`, status: 'pending' });
      await stuckRow(w, { path: `${KB}/Data/QA/clean.md`, status: 'running' });
      // The draft's working copy cannot reach the repository.
      await runGit(w.repo(workspaceIdForBranch(DRAFT)), ['remote', 'set-url', 'origin', path.join(w.root, 'nowhere.git')]);
      await stuckRow(w, { path: `${KB}/Data/QA/clean.md`, branch: DRAFT });

      await expect(w.svc.clearEscalatedCommits()).resolves.toBeUndefined();

      expect(await rowsLeft(w)).toEqual([
        { path: `${KB}/Data/QA/b.md`, status: 'pending' },
        { path: `${KB}/Data/QA/clean.md`, status: 'needs_attention' },
        { path: `${KB}/Data/QA/clean.md`, status: 'running' },
      ]);
      const left = await w.db.select().from(pendingCommits);
      expect(left.find((r) => r.status === 'needs_attention')?.branch).toBe(DRAFT);
    },
    PG_TEST_TIMEOUT,
  );
});
