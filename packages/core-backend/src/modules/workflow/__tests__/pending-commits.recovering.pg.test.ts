import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AuthUser } from '@bevel-software/platform-shared';
import { closeDb, coreMigrationsDir, createDb, runCoreMigrations, type Database, type RecoveryAgentRunner } from '../../../index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, scratchDatabaseUrl } from '../../../__tests__/pg-scratch.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';
import { GitService } from '../git/git.service.js';
import { gitOut, runGit, stubWorkflowHooks, stubWorkspaceService } from '../git/__tests__/git-test-helpers.js';
import { PendingCommitsService } from '../pending-commits.service.js';
import { N_TRANSIENT, PendingCommitsWorker } from '../pending-commits.worker.js';
import { WorkflowService } from '../workflow.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { FileLockService } from '../file-lock.service.js';

/**
 * The recovery agent can merge the branch it was spawned for.
 *
 * A save whose push keeps failing because the shared branch moved under it,
 * and whose replay conflicts, is handed to the recovery agent. The agent's
 * one way to rescue it is `update_branch`: merge the shared branch into the
 * workspace, resolve, publish. That merge waits for every commit still queued
 * on the branch — and the commit under rescue used to be one of them, so the
 * agent always heard `pending-commits`.
 *
 * Pinned here over the real pieces: the queue in a real Postgres (the status
 * check constraint included, through the migration history a start applies),
 * the real worker draining it, real git under the workflow service, and a stub
 * recovery runner that does what the agent would — call `updateBranch`.
 *
 * Runs where `TEST_DATABASE_URL` names a server this role may create databases
 * on (`pg-scratch.ts`).
 */

const DRAFT = 'ada/draft';
const WS = encodeURIComponent(DRAFT);
const BOT: AuthUser = { id: 'recovery-bot', email: 'recovery-bot@bevel.local', name: 'Recovery Bot' };
const SAVE = 'knowledge-base/shared.md';

const open: Database[] = [];
const roots: string[] = [];

/** A migrated scratch database, as a start leaves it. */
async function migratedDb(): Promise<Database> {
  const db = createDb(await scratchDatabaseUrl('hexis_recovering'), { piiKey: randomBytes(32).toString('base64') });
  open.push(db);
  await runCoreMigrations(db, coreMigrationsDir());
  return db;
}

/** An upstream with the draft, the draft's workspace clone, and a second clone to move the draft as someone else. */
async function seed(): Promise<{ repo: string; pusher: string; workspaceDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-recovering-'));
  roots.push(root);
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', DRAFT, upstream]);
  const seedDir = path.join(root, '.seed');
  await fs.mkdir(seedDir);
  await runGit(seedDir, ['init', '-b', DRAFT]);
  await runGit(seedDir, ['remote', 'add', 'origin', upstream]);
  await fs.writeFile(path.join(seedDir, 'shared.md'), 'line 1\nline 2\nline 3\n');
  await runGit(seedDir, ['add', '.']);
  await runGit(seedDir, ['commit', '-q', '-m', 'init']);
  await runGit(seedDir, ['push', '-q', 'origin', DRAFT]);

  const workspaceDir = path.join(root, WS);
  const repo = path.join(workspaceDir, 'knowledge-base');
  await fs.mkdir(workspaceDir, { recursive: true });
  for (const [dir, email, name] of [
    [repo, 'workspace@bevel.test', 'bevel Workspace'],
    [path.join(root, '.pusher'), 'bob@x.io', 'Bob'],
  ] as const) {
    await runGit(root, ['-c', 'core.autocrlf=false', 'clone', '-q', '-b', DRAFT, upstream, dir]);
    await runGit(dir, ['config', 'user.email', email]);
    await runGit(dir, ['config', 'user.name', name]);
    await runGit(dir, ['config', 'core.autocrlf', 'false']);
  }
  return { repo, pusher: path.join(root, '.pusher'), workspaceDir };
}

function workflowOver(db: Database, pending: PendingCommitsService, workspaceDir: string): WorkflowService {
  const kb = testKbContext();
  const git = new GitService(stubWorkspaceService({ [WS]: workspaceDir }), stubWorkflowHooks(), kb);
  // A resolution is read at both commits the merge is of; every path is the bot's to read here.
  const accessControl = { canReadAtRef: async () => true } as unknown as IAccessControl;
  const svc = new WorkflowService(
    db,
    git,
    {} as unknown as PullRequestService,
    {} as unknown as IReviewWorkflowService,
    {} as unknown as WorkspaceService,
    accessControl,
    {} as unknown as FileLockService,
    pending,
    kb,
    openChangeGate(),
  );
  // The wait a refused merge answers after; short, so a refusal costs the test little.
  svc.mergeWaitForPendingCommits = { timeoutMs: 300, pollMs: 20 };
  return svc;
}

/** The real worker over the real queue, its passes a few milliseconds apart. */
function workerOver(
  pending: PendingCommitsService,
  workflow: WorkflowService,
  recoveryAgent: RecoveryAgentRunner,
  now: () => Date,
  notices: string[],
): PendingCommitsWorker {
  return new PendingCommitsWorker({
    service: pending,
    workflow,
    recoveryAgent,
    feedback: { send: async (n) => void notices.push(n.message) },
    workspaces: { knownWorkspaces: () => [{ id: WS, branch: DRAFT }] },
    recoveryBot: BOT,
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))),
  });
}

/** Wait until `done` answers true; fails the test after `ms`. */
async function until(done: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The pass clock: rows a pass may claim are those whose backoff ended before it. */
function clock() {
  let at = Date.now();
  return {
    now: () => new Date(at),
    /** Every backoff now over. */
    later: () => {
      at = Date.now() + 60 * 60_000;
    },
    /** Nothing that was attempted just now is ready yet. */
    frozen: () => {
      at = Date.now();
    },
  };
}

describe.skipIf(!PG_ADMIN_URL)('a commit under recovery (real Postgres, real git)', () => {
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => closeDb(db)));
    await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  });
  afterAll(dropScratchDatabases, PG_TEST_TIMEOUT);

  let db: Database;
  let pending: PendingCommitsService;
  beforeEach(async () => {
    db = await migratedDb();
    pending = new PendingCommitsService(db);
  }, PG_TEST_TIMEOUT);

  it(
    'lets the agent merge and publish its own branch, holds the merge for any other save, and lands the row after',
    async () => {
      const { repo, pusher, workspaceDir } = await seed();
      const svc = workflowOver(db, pending, workspaceDir);
      const t = clock();

      // Ada saves line 2; Bob has already pushed his own line 2 to the shared draft.
      await fs.writeFile(path.join(repo, 'shared.md'), 'line 1\nline 2 by Ada\nline 3\n');
      await pending.enqueue({ workspaceId: WS, branch: DRAFT, path: SAVE, authorEmail: 'ada@x.io', authorName: 'Ada' });
      await fs.writeFile(path.join(pusher, 'shared.md'), 'line 1\nline 2 by Bob\nline 3\n');
      await runGit(pusher, ['commit', '-q', '-am', 'Bob edits line 2']);
      await runGit(pusher, ['push', '-q', 'origin', DRAFT]);

      const seen: Record<string, unknown> = {};
      const recoveryAgent: RecoveryAgentRunner = {
        run: async () => {
          // While the agent runs, the row is out of every pass's reach, and
          // out of the count the merge waits on — but still a commit to land.
          seen.claimable = await pending.claimNext(WS, new Date(Date.now() + 60 * 60_000));
          seen.queued = await pending.queuedOnBranch(DRAFT, { into: true });
          // A merge OUT of the branch still waits for it: its save is not on the remote.
          seen.queuedOut = await pending.queuedOnBranch(DRAFT);
          seen.live = await pending.hasLiveRowFor(WS, DRAFT, SAVE);
          // Readiness still waits on it: the oldest commit not yet landed.
          seen.oldest = await pending.oldestQueuedAt();
          // What `branch_status` lists as uncommitted: the save is committed
          // in the workspace (its push is what failed), so nothing.
          seen.uncommitted = await svc.listPendingChangePaths(WS);

          // The agent's `update_branch`, no `from`: not refused for its own
          // row. The replay conflicts, so the first call describes it…
          const described = await svc.updateBranch(WS, BOT);
          seen.described = described.kind;
          // …and the second resolves and publishes.
          seen.merged = await svc.updateBranch(WS, BOT, {
            resolutions: [{ path: 'shared.md', content: 'line 1\nline 2 by Ada and Bob\nline 3\n' }],
            validateWrite: async () => undefined,
          });

          // A save made during the run is queued `pending`, and holds the merge.
          await fs.writeFile(path.join(repo, 'late.md'), 'saved during the recovery run\n');
          await pending.enqueue({ workspaceId: WS, branch: DRAFT, path: 'knowledge-base/late.md', authorEmail: 'ada@x.io', authorName: 'Ada' });
          seen.heldBySave = await svc.updateBranch(WS, BOT);

          // Nothing tried just now is ready on the rest of this pass.
          t.frozen();
        },
      };
      const notices: string[] = [];
      const worker = workerOver(pending, svc, recoveryAgent, t.now, notices);
      t.later();
      worker.start();
      try {
        // The save's transient budget is spent, the agent runs, and the save
        // made during the run lands on the rest of that pass.
        await until(async () => seen.heldBySave !== undefined && !(await pending.hasLiveRowFor(WS, DRAFT, 'knowledge-base/late.md')));

        expect(seen.claimable).toBeNull();
        expect(seen.queued).toEqual({ queued: 0, stuck: 0, needsAttention: null });
        expect(seen.queuedOut).toEqual({ queued: 1, stuck: 0, needsAttention: null });
        expect(seen.live).toBe(true);
        expect(seen.oldest).toBeInstanceOf(Date);
        expect(seen.uncommitted).toEqual([]);
        expect(seen.described).toBe('conflicts');
        expect(seen.merged).toMatchObject({ kind: 'merged', from: DRAFT, resolvedPaths: ['shared.md'] });
        expect(seen.heldBySave).toMatchObject({ kind: 'pending-commits', branch: DRAFT, pending: 1 });
        // Published: the shared draft holds both edits, resolved, as the agent's merge.
        const published = await gitOut(pusher, ['fetch', '-q', 'origin']).then(() =>
          gitOut(pusher, ['show', `origin/${DRAFT}:shared.md`]),
        );
        expect(published).toBe('line 1\nline 2 by Ada and Bob\nline 3');

        // The agent has returned: the row is `pending` again — not claimed on
        // the pass the agent ran in (its backoff has not run out), but on the next.
        expect(await pending.countPending(WS)).toBe(1);
        t.later();
        // The retry finds the save already on the shared branch: a success, and the row is gone.
        await until(async () => !(await pending.hasAnyForWorkspace(WS)));
      } finally {
        await worker.stop();
      }
      expect(notices).toEqual([]);
      await gitOut(pusher, ['fetch', '-q', 'origin']);
      expect(await gitOut(pusher, ['show', `origin/${DRAFT}:late.md`])).toBe('saved during the recovery run');
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'retries the row on the next pass whether the agent exited early or threw',
    async () => {
      for (const ending of ['exited early', 'threw'] as const) {
        const t = clock();
        // The commit fails until the agent has run, then lands.
        let agentRan = false;
        let attempts = 0;
        const driver = {
          runPendingCommit: async () => {
            attempts += 1;
            if (!agentRan) throw new Error('push rejected');
          },
        };
        let during: unknown;
        const recoveryAgent: RecoveryAgentRunner = {
          run: async () => {
            during = await pending.claimNext(WS, new Date(Date.now() + 60 * 60_000));
            agentRan = true;
            t.frozen();
            if (ending === 'threw') throw new Error('the agent died');
          },
        };
        await pending.enqueue({ workspaceId: WS, branch: DRAFT, path: SAVE, authorEmail: 'ada@x.io', authorName: 'Ada' });
        const notices: string[] = [];
        const worker = new PendingCommitsWorker({
          service: pending,
          workflow: driver,
          recoveryAgent,
          feedback: { send: async (n) => void notices.push(n.message) },
          workspaces: { knownWorkspaces: () => [{ id: WS, branch: DRAFT }] },
          recoveryBot: BOT,
          now: t.now,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))),
        });
        t.later();
        worker.start();
        try {
          await until(async () => agentRan);
          await until(async () => (await pending.countPending(WS)) === 1);
          expect(during).toBeNull();
          expect(attempts).toBe(N_TRANSIENT);
          t.later();
          await until(async () => !(await pending.hasAnyForWorkspace(WS)));
        } finally {
          await worker.stop();
        }
        expect(attempts, ending).toBe(N_TRANSIENT + 1);
        expect(notices, ending).toEqual([]);
      }
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'a restart during a recovery run leaves the row retryable',
    async () => {
      await pending.enqueue({ workspaceId: WS, branch: DRAFT, path: SAVE, authorEmail: 'ada@x.io', authorName: 'Ada' });
      const later = () => new Date(Date.now() + 60 * 60_000);
      const row = await pending.claimNext(WS, later());
      expect(row).not.toBeNull();
      // The worker handed it to the agent, and the process died mid-run.
      await pending.markRecoveryStarted(row!.id);
      expect(await pending.claimNext(WS, later())).toBeNull();
      // Not landed, so readiness still reports it as the oldest commit waiting.
      expect(await pending.oldestQueuedAt()).toEqual(row!.queuedAt);

      // The next process's boot.
      await pending.startupReconcile([], { scan: async () => [] }, { email: BOT.email, name: BOT.name });

      expect(await pending.countPending(WS)).toBe(1);
      const retried = await pending.claimNext(WS, later());
      expect(retried).toMatchObject({ id: row!.id, status: 'running', attempts: 0, recoveryAgentRuns: 1 });
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'a row escalated before the hand-off is not put under recovery',
    async () => {
      await pending.enqueue({ workspaceId: WS, branch: DRAFT, path: SAVE, authorEmail: 'ada@x.io', authorName: 'Ada' });
      const row = await pending.claimNext(WS, new Date(Date.now() + 60 * 60_000));
      // The repository is replaced while the worker holds the row.
      expect(await pending.markNeedsAttentionOnBranch(DRAFT, 'The repository was replaced.')).toBe(1);
      expect(await pending.markRecoveryStarted(row!.id)).toBe(false);
      expect(await pending.queuedOnBranch(DRAFT)).toEqual({ queued: 0, stuck: 1, needsAttention: 'The repository was replaced.' });
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'a row escalated while the agent ran stays escalated when the agent returns',
    async () => {
      await pending.enqueue({ workspaceId: WS, branch: DRAFT, path: SAVE, authorEmail: 'ada@x.io', authorName: 'Ada' });
      const row = await pending.claimNext(WS, new Date(Date.now() + 60 * 60_000));
      expect(await pending.markRecoveryStarted(row!.id)).toBe(true);
      // The repository is replaced mid-run: the row goes to a person.
      expect(await pending.markNeedsAttentionOnBranch(DRAFT, 'The repository was replaced.')).toBe(1);
      await pending.markRecoveryFinished(row!.id);
      expect(await pending.queuedOnBranch(DRAFT)).toEqual({ queued: 0, stuck: 1, needsAttention: 'The repository was replaced.' });
      expect(await pending.countPending(WS)).toBe(0);
    },
    PG_TEST_TIMEOUT,
  );
});
