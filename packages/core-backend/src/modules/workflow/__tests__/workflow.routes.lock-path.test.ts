import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AuthUser, Change, IWorkflowService } from '@bevel-software/platform-shared';
import type { Database } from '../../database/connection.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import { WorkflowEventBus } from '../event-bus.js';
import { WorkflowService } from '../workflow.service.js';
import { createWorkflowRoutes } from '../workflow.routes.js';
import { makeFakeLockDb, type FakeLockDb } from './fake-file-lock-db.js';

/**
 * The lock routes over the real service and a real lock store: acquire,
 * release, checkpoint, heartbeat and the status read all have to find the
 * same lock whichever spelling of the file the client sends, and refuse the
 * spellings the file verbs refuse with the same status.
 *
 * Wired end to end on purpose. A spy on `IWorkflowService` would only prove
 * the routes pass a string along, and the whole question is which row that
 * string lands on.
 */

const ALICE: AuthUser = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com', name: 'Alice' };
const BOB: AuthUser = { id: '22222222-2222-4222-8222-222222222222', email: 'bob@example.com', name: 'Bob' };

const WS = 'feat%2Fx';
const BRANCH = 'feat/x'; // Deliberately not protected: no write gate in the way.
const KB = 'knowledge-base';
const CANONICAL = `${KB}/x/a.md`;
const RAW = `./${KB}//x//a.md`;

const CHANGE: Change = {
  sha: 'abc1234',
  authorName: 'Alice',
  authorEmail: 'alice@example.com',
  subject: 'edit a.md',
  committedAt: '2026-04-20T00:00:00.000Z',
};

interface Harness {
  server: Server;
  baseUrl: string;
  fake: FakeLockDb;
  enqueue: ReturnType<typeof vi.fn>;
  commitFile: ReturnType<typeof vi.fn>;
  /** Whose credentials the next request carries. */
  actAs: (user: AuthUser) => void;
}

async function makeHarness(): Promise<Harness> {
  const fake = makeFakeLockDb();
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const commitFile = vi.fn().mockResolvedValue(CHANGE);
  const git = {
    commitFile,
    push: vi.fn().mockResolvedValue(undefined),
    discardPath: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitService;
  const pending = {
    enqueue,
    hasLiveRowFor: vi.fn().mockResolvedValue(false),
  } as unknown as PendingCommitsService;
  const events = new WorkflowEventBus();
  const workflow = new WorkflowService(
    {} as unknown as Database,
    git,
    {} as PullRequestService,
    {} as IReviewWorkflowService,
    {} as WorkspaceService,
    {} as IAccessControl,
    new FileLockService(fake.db),
    pending,
    KB,
    events,
  );

  let current = ALICE;
  const authService = {
    getUserById: vi.fn(async (id: string) => (id === BOB.id ? BOB : ALICE)),
  } as unknown as AuthService;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = current.id;
    next();
  });
  app.use(
    '/api',
    createWorkflowRoutes(
      workflow as unknown as IWorkflowService,
      {} as unknown as WorkspaceService,
      authService,
      events,
      {} as unknown as IAccessControl,
      KB,
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    fake,
    enqueue,
    commitFile,
    actAs: (user) => {
      current = user;
    },
  };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

describe('lock routes coordinate on one file identity', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await close(h.server);
  });

  const url = (suffix: string) => `${h.baseUrl}/api/workspace/${WS}/workflow/locks${suffix}`;
  const send = (method: string, suffix: string, body: unknown) =>
    fetch(url(suffix), {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const acquire = (targetPath: string) => send('POST', '', { branch: BRANCH, path: targetPath });
  const release = (targetPath: string) => send('DELETE', '', { branch: BRANCH, path: targetPath });
  const heartbeat = (targetPath: string) =>
    send('POST', '/heartbeat', { branch: BRANCH, path: targetPath });
  const checkpoint = (targetPath: string) =>
    send('POST', '/checkpoint', { branch: BRANCH, path: targetPath });
  const status = (targetPath: string) =>
    fetch(
      `${url('')}?branch=${encodeURIComponent(BRANCH)}&path=${encodeURIComponent(targetPath)}`,
    );

  it('refuses a second acquire spelled differently, as if it were the same spelling', async () => {
    expect(await (await acquire(RAW)).json()).toMatchObject({ acquired: true });

    h.actAs(BOB);
    const second = await acquire(CANONICAL);

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      acquired: false,
      lock: { holderUserId: ALICE.id, path: CANONICAL },
    });
    expect(h.fake.rows()).toHaveLength(1);
  });

  it('heartbeats across spellings', async () => {
    await acquire(RAW);

    const beat = await heartbeat(CANONICAL);

    expect(beat.status).toBe(200);
    expect(await beat.json()).toMatchObject({ holderUserId: ALICE.id, path: CANONICAL });
  });

  it('checkpoints across spellings, and commits the canonical path', async () => {
    await acquire(CANONICAL);

    const saved = await checkpoint(RAW);

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ change: { sha: CHANGE.sha } });
    // The commit stages the canonical path. Handed the raw spelling, git's
    // own pathspec guard would have refused it and the checkpoint would have
    // failed AFTER finding the lock.
    // Express decodes `:id`, so the service sees the branch spelling.
    expect(h.commitFile).toHaveBeenCalledWith(BRANCH, ALICE, CANONICAL, undefined);
    // Checkpoint keeps the lock.
    expect(h.fake.rows()).toHaveLength(1);
  });

  it('releases across spellings, and queues the commit for the canonical path', async () => {
    await acquire(RAW);

    const released = await release(CANONICAL);

    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ queued: true });
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ branch: BRANCH, path: CANONICAL }),
    );
    expect(h.fake.rows()).toEqual([]);
  });

  it('releases the other way round too: taken canonically, released raw', async () => {
    await acquire(CANONICAL);

    expect((await release(RAW)).status).toBe(200);
    expect(h.fake.rows()).toEqual([]);
  });

  it('reads the lock status across spellings', async () => {
    await acquire(RAW);

    const read = await status(CANONICAL);

    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      lock: { holderUserId: ALICE.id, path: CANONICAL },
    });
  });

  it('reads the status of a raw spelling after a canonical acquire', async () => {
    await acquire(CANONICAL);

    expect(await (await status(RAW)).json()).toMatchObject({
      lock: { holderUserId: ALICE.id, path: CANONICAL },
    });
  });

  /**
   * Same statuses `PUT /file` answers for these inputs: 400 for a path that
   * is not usable as a workspace-relative path, 403 for one that resolves
   * outside the workspace. See `canonical-file-identity.test.ts`, which pins
   * that equivalence input by input.
   */
  describe('refuses the paths the file verbs refuse', () => {
    const REFUSED: [string, string, number][] = [
      ['climbs out', '../etc/passwd', 400],
      ['climbs out from inside', `${KB}/../../etc/passwd`, 400],
      ['launders back inside', `${KB}/x/../y.md`, 400],
      ['uses backslashes', `${KB}\\x\\a.md`, 400],
      ['is absolute', '/etc/passwd', 403],
    ];

    it.each(REFUSED)('acquire refuses a path that %s', async (_why, badPath, expected) => {
      expect((await acquire(badPath)).status).toBe(expected);
      expect(h.fake.rows()).toEqual([]);
    });

    it.each(REFUSED)('release refuses a path that %s', async (_why, badPath, expected) => {
      expect((await release(badPath)).status).toBe(expected);
      expect(h.enqueue).not.toHaveBeenCalled();
    });

    it.each(REFUSED)('heartbeat refuses a path that %s', async (_why, badPath, expected) => {
      expect((await heartbeat(badPath)).status).toBe(expected);
    });

    it.each(REFUSED)('checkpoint refuses a path that %s', async (_why, badPath, expected) => {
      expect((await checkpoint(badPath)).status).toBe(expected);
      expect(h.commitFile).not.toHaveBeenCalled();
    });

    it.each(REFUSED)('the status read refuses a path that %s', async (_why, badPath, expected) => {
      expect((await status(badPath)).status).toBe(expected);
    });

    it('answers an absolute path with the file verbs\' own wording', async () => {
      const refused = await acquire('/etc/passwd');
      expect(await refused.json()).toMatchObject({ error: 'Path traversal detected' });
    });
  });
});
