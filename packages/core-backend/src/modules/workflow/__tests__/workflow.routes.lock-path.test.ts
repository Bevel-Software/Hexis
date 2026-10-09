import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
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
import { openChangeGate } from '../../../__tests__/open-change-gate.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';

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
  /** The service behind the routes, for the in-process callers (an agent's edits) that use it directly. */
  workflow: IWorkflowService;
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
    testKbContext({ kbDirName: KB }),
    openChangeGate(),
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
    workflow: workflow as unknown as IWorkflowService,
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

  it('stores a lock taken through the route under the encoded workspace id the deletion gate asks with', async () => {
    // Express hands the route the decoded `:id`; the deletion paths and an
    // agent's edits ask with `workspaceIdForBranch(branch)`, the encoded one.
    await acquire(CANONICAL);

    expect(h.fake.rows().map((r) => r.workspaceId)).toEqual([WS]);
    expect((await release(CANONICAL)).status).toBe(200);
    expect(h.fake.rows()).toEqual([]);
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
      // Absolute, but spelled to look contained under the stand-in root
      // `canonicalFileIdentity` resolves against. A real workspace directory
      // is `<workspacesRoot>/<id>`, so `PUT /file` resolves this outside it
      // and answers 403.
      ['is absolute under a workspace-looking root', '/workspace/a.md', 403],
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

    /**
     * A truthy non-string `path` clears the routes' own `!targetPath` guard,
     * so the service is what has to refuse it. `PUT /file` answers 400 (its
     * `requestPath` type-guards before canonicalising); unguarded, the
     * canonicaliser would call `.startsWith` on the number and the resulting
     * `TypeError` would leave here as a 500.
     */
    it('refuses a truthy non-string path with 400 on every lock route', async () => {
      const body = { branch: BRANCH, path: 123 };
      const responses = await Promise.all([
        send('POST', '', body),
        send('DELETE', '', body),
        send('POST', '/heartbeat', body),
        send('POST', '/checkpoint', body),
      ]);

      expect(responses.map((r) => r.status)).toEqual([400, 400, 400, 400]);
      expect(h.fake.rows()).toEqual([]);
      expect(h.enqueue).not.toHaveBeenCalled();
      expect(h.commitFile).not.toHaveBeenCalled();
    });
  });
});

/**
 * A slashed branch's workspace has two spellings: the lock routes get the
 * `:id` Express decoded (`feat/x`), while an agent's edits and the deletion
 * gate use the encoded id (`feat%2Fx`). They are one workspace — one clone,
 * one branch — so they are one lock: a file a person holds in the app is held
 * against an agent's edit too, and the other way round.
 */
describe('lock routes coordinate on one workspace identity', () => {
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
  const acquire = () => send('POST', '', { branch: BRANCH, path: CANONICAL });
  const release = () => send('DELETE', '', { branch: BRANCH, path: CANONICAL });
  const heartbeat = () => send('POST', '/heartbeat', { branch: BRANCH, path: CANONICAL });
  const status = () =>
    fetch(`${url('')}?branch=${encodeURIComponent(BRANCH)}&path=${encodeURIComponent(CANONICAL)}`);

  it("holds a file taken in the app against an agent's edit, and frees it on release", async () => {
    expect(await (await acquire()).json()).toMatchObject({ acquired: true });

    await expect(h.workflow.acquireLock(workspaceIdForBranch(BRANCH), BRANCH, CANONICAL, BOB)).resolves.toMatchObject({
      acquired: false,
      lock: { holderUserId: ALICE.id },
    });

    expect((await release()).status).toBe(200);
    await expect(h.workflow.acquireLock(workspaceIdForBranch(BRANCH), BRANCH, CANONICAL, BOB)).resolves.toMatchObject({
      acquired: true,
    });
  });

  it("holds a file an agent took against the app, which reads its status", async () => {
    await h.workflow.acquireLock(workspaceIdForBranch(BRANCH), BRANCH, CANONICAL, ALICE);

    expect(await (await status()).json()).toMatchObject({ lock: { holderUserId: ALICE.id } });
    h.actAs(BOB);
    expect(await (await acquire()).json()).toMatchObject({ acquired: false, lock: { holderUserId: ALICE.id } });
    expect(h.fake.rows()).toHaveLength(1);
  });

  it('leaves an unslashed workspace id as it is', async () => {
    const res = await fetch(`${h.baseUrl}/api/workspace/main/workflow/locks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: 'main', path: CANONICAL }),
    });
    expect(res.status).toBe(200);
    expect(h.fake.rows().map((r) => r.workspaceId)).toEqual(['main']);
  });

  describe('a lock the previous version left under the decoded id', () => {
    /** A row as the previous version wrote it through these routes. */
    const seedLegacy = (expiresInMs: number) => {
      const now = Date.now();
      h.fake.seed({
        workspaceId: BRANCH,
        branch: BRANCH,
        path: CANONICAL,
        holderUserId: ALICE.id,
        holderName: ALICE.name,
        mode: 'edit',
        acquiredAt: new Date(now - 1_000),
        lastHeartbeatAt: new Date(now - 1_000),
        expiresAt: new Date(now + expiresInMs),
      });
    };

    it("while live: the app reads it, another editor and an agent's edit are refused, its holder heartbeats and releases it", async () => {
      seedLegacy(30_000);

      expect(await (await status()).json()).toMatchObject({ lock: { holderUserId: ALICE.id } });
      h.actAs(BOB);
      expect(await (await acquire()).json()).toMatchObject({ acquired: false, lock: { holderUserId: ALICE.id } });
      await expect(h.workflow.acquireLock(workspaceIdForBranch(BRANCH), BRANCH, CANONICAL, BOB)).resolves.toMatchObject({
        acquired: false,
      });
      // No second row was written beside it.
      expect(h.fake.rows().map((r) => r.workspaceId)).toEqual([BRANCH]);

      h.actAs(ALICE);
      const beat = await heartbeat();
      expect(beat.status).toBe(200);
      expect(new Date((await beat.json()).expiresAt).getTime()).toBeGreaterThan(Date.now() + 30_000);
      expect(await (await release()).json()).toEqual({ queued: true });
      expect(h.fake.rows()).toEqual([]);
    });

    it('once expired: it holds nothing, and the file is taken under the encoded id', async () => {
      seedLegacy(-1_000);

      expect(await (await status()).json()).toMatchObject({ lock: null });
      h.actAs(BOB);
      expect(await (await acquire()).json()).toMatchObject({ acquired: true, lock: { holderUserId: BOB.id } });
      expect(h.fake.rows().map((r) => r.workspaceId)).toEqual([WS]);
    });
  });
});
