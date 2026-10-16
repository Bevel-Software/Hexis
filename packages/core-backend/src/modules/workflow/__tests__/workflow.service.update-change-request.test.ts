import { describe, it, expect, vi } from 'vitest';
import type { AuthUser, WorkflowEventPayload } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';
import { hashEmail } from '../../../shared/email-identity.js';
import type { Database } from '../../database/connection.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import type { WorkflowEventBus } from '../event-bus.js';
import { WorkflowService } from '../workflow.service.js';

/**
 * Who may change an open request's title and description: its author, or
 * anyone who may merge it — an admin (write on `roles.yaml` at the base), or
 * the holder of write on every file it changes. Everyone else is refused in
 * words (403), and so is a request that is no longer open (409). These pin
 * that rule and what an allowed edit writes.
 */

const AUTHOR = 'alice@example.com';
const OTHER = 'mallory@example.com';
const GENERATED = '## Affected owners\n\n- `Docs/a.md` — Admin';

const user = (email: string, name = 'Caller'): AuthUser => ({ id: `u-${email}`, email, name });

function harness(
  opts: {
    state?: string;
    authorEmail?: string;
    isAdmin?: boolean | null;
    writes?: Record<string, boolean> | null;
    files?: string[];
    body?: string;
  } = {},
) {
  const state = opts.state ?? 'open';
  const summary = {
    number: 9,
    title: 'Old title',
    base: 'main',
    branch: 'mallory/draft',
    state,
    authorId: hashEmail(opts.authorEmail ?? OTHER),
    url: '/change-requests/9',
  };
  const prs = {
    getPr: vi.fn(async () => summary),
    getPrDetail: vi.fn(async () => ({
      ...summary,
      files: (opts.files ?? ['Docs/a.md', 'Docs/b.md']).map((path) => ({ path })),
    })),
    invalidateDetailCache: vi.fn(),
  } as unknown as PullRequestService;

  const written: Record<string, unknown>[] = [];
  // The transaction hands its callback a client of its OWN: every read and
  // write of the row must go through it, so a read that slipped outside the
  // transaction (and so outside the row lock) lands on `db` instead.
  const tx = {
    select: vi.fn(() => tx),
    from: vi.fn(() => tx),
    where: vi.fn(() => tx),
    limit: vi.fn(() => tx),
    for: vi.fn(async () => (state === 'open' ? [{ body: opts.body ?? `Old reason.\n\n${GENERATED}` }] : [])),
    update: vi.fn(() => tx),
    set: vi.fn((values: Record<string, unknown>) => {
      written.push(values);
      return tx;
    }),
    returning: vi.fn(async () => [{ id: 'row-9' }]),
  };
  // The outer client answers every query with no rows: only background
  // housekeeping (the deleted-branch sweep) may read through it.
  const outer: Record<string, unknown> = {
    then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
  };
  for (const step of ['from', 'where', 'limit', 'orderBy', 'innerJoin', 'set']) outer[step] = () => outer;
  const db = {
    select: vi.fn(() => outer),
    update: vi.fn(() => outer),
    transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
  };

  const writes = opts.writes === undefined ? {} : opts.writes;
  const access = {
    canWriteAtRef: vi.fn(async () => (opts.isAdmin === undefined ? false : opts.isAdmin)),
    canWriteBatchAtRef: vi.fn(async (_ws: string, _ref: string, _email: string, paths: string[]) =>
      writes === null ? null : new Map(paths.map((p) => [p, writes[p] === true])),
    ),
  } as unknown as IAccessControl;
  const workspaces = {
    getOrCreateForBranch: vi.fn(async (b: string) => ({ id: encodeURIComponent(b) })),
    ensureRemotesFetched: vi.fn(async () => undefined),
  } as unknown as WorkspaceService;
  const emitted: WorkflowEventPayload[] = [];
  const events = { emit: (e: WorkflowEventPayload) => emitted.push(e) } as unknown as WorkflowEventBus;

  const svc = new WorkflowService(
    db as unknown as Database,
    {} as GitService,
    prs,
    {} as IReviewWorkflowService,
    workspaces,
    access,
    {} as FileLockService,
    {} as PendingCommitsService,
    testKbContext(),
    openChangeGate(),
    events,
  );
  return { svc, db, tx, written, prs, access, workspaces, emitted };
}

describe('WorkflowService.updateChangeRequest — who may edit', () => {
  it('lets the AUTHOR edit without any further grant, and resolves no workspace and reads no access tree', async () => {
    const h = harness({ authorEmail: AUTHOR });
    await h.svc.updateChangeRequest(9, user(AUTHOR), { description: 'P2 - Planned\n\nNew reason.' });
    expect(h.written).toHaveLength(1);
    expect(h.access.canWriteAtRef).not.toHaveBeenCalled();
    expect(h.workspaces.getOrCreateForBranch).not.toHaveBeenCalled();
  });

  it('matches the author case-insensitively, as authorship is stored', async () => {
    const h = harness({ authorEmail: AUTHOR });
    await h.svc.updateChangeRequest(9, user('  Alice@Example.com '), { title: 'New' });
    expect(h.written).toHaveLength(1);
  });

  it('lets an ADMIN edit someone else’s request', async () => {
    const h = harness({ isAdmin: true });
    await h.svc.updateChangeRequest(9, user('admin@example.com'), { title: 'New' });
    expect(h.written).toHaveLength(1);
    expect(h.access.canWriteAtRef).toHaveBeenCalledWith('main', 'origin/main', 'admin@example.com', 'roles.yaml');
  });

  it('lets someone who may approve EVERY changed file edit it', async () => {
    const h = harness({ writes: { 'Docs/a.md': true, 'Docs/b.md': true } });
    await h.svc.updateChangeRequest(9, user('owner@example.com'), { title: 'New' });
    expect(h.written).toHaveLength(1);
    // Read at the base, behind a strict fetch — never a stale local ref.
    expect(h.workspaces.ensureRemotesFetched).toHaveBeenCalledWith('main', { strict: true });
    expect(h.access.canWriteBatchAtRef).toHaveBeenCalledWith('main', 'origin/main', 'owner@example.com', [
      'Docs/a.md',
      'Docs/b.md',
    ]);
  });

  it('refuses someone who may approve only SOME of the files, in words, and writes nothing', async () => {
    const h = harness({ writes: { 'Docs/a.md': true } });
    await expect(h.svc.updateChangeRequest(9, user('half@example.com'), { title: 'New' })).rejects.toMatchObject({
      status: 403,
      message:
        "Only the request's author, an admin, or someone who may approve every file it changes can edit its title and description.",
    });
    expect(h.tx.update).not.toHaveBeenCalled();
    expect(h.emitted).toEqual([]);
  });

  it('refuses a stranger with the same 403', async () => {
    const h = harness();
    await expect(h.svc.updateChangeRequest(9, user('stranger@example.com'), { description: 'x' })).rejects.toMatchObject({
      status: 403,
    });
    expect(h.tx.update).not.toHaveBeenCalled();
  });

  it('an empty file list grants nobody but the author and admins', async () => {
    const h = harness({ files: [] });
    await expect(h.svc.updateChangeRequest(9, user('stranger@example.com'), { title: 'New' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('answers 409 rather than 403 when the base branch cannot be resolved', async () => {
    const h = harness({ isAdmin: null });
    await expect(h.svc.updateChangeRequest(9, user('admin@example.com'), { title: 'New' })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('could not be resolved'),
    });
    expect(h.tx.update).not.toHaveBeenCalled();
  });

  it('refuses a MERGED request with a worded 409, even to its author', async () => {
    const h = harness({ state: 'merged', authorEmail: AUTHOR });
    await expect(h.svc.updateChangeRequest(9, user(AUTHOR), { title: 'New' })).rejects.toMatchObject({
      status: 409,
      message: 'This change request has already been applied; its title and description can no longer be changed.',
    });
    expect(h.tx.update).not.toHaveBeenCalled();
  });

  it('refuses a CLOSED request with a worded 409, even to an admin', async () => {
    const h = harness({ state: 'closed', isAdmin: true });
    await expect(h.svc.updateChangeRequest(9, user('admin@example.com'), { title: 'New' })).rejects.toMatchObject({
      status: 409,
      message: 'This change request is closed; its title and description can no longer be changed.',
    });
    expect(h.tx.update).not.toHaveBeenCalled();
  });

  it('refuses a request that does not exist with 404', async () => {
    const h = harness();
    (h.prs.getPr as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(h.svc.updateChangeRequest(9, user(AUTHOR), { title: 'New' })).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an edit that changes nothing, or empties the title, with 400', async () => {
    const h = harness({ authorEmail: AUTHOR });
    await expect(h.svc.updateChangeRequest(9, user(AUTHOR), {})).rejects.toMatchObject({ status: 400 });
    await expect(h.svc.updateChangeRequest(9, user(AUTHOR), { title: '   ' })).rejects.toMatchObject({ status: 400 });
    expect(h.tx.update).not.toHaveBeenCalled();
  });

  it('refuses a title past 256 characters with 400 — the agent tool’s limit, for the route too', async () => {
    const h = harness({ authorEmail: AUTHOR });
    await h.svc.updateChangeRequest(9, user(AUTHOR), { title: 'x'.repeat(256) });
    await expect(h.svc.updateChangeRequest(9, user(AUTHOR), { title: 'x'.repeat(257) })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('at most 256 characters'),
    });
    expect(h.written).toHaveLength(1);
  });

  it('refuses a description holding the generated block’s heading, which would cut it short on read', async () => {
    const h = harness({ authorEmail: AUTHOR });
    for (const input of [
      { description: `Mine.\n\n${GENERATED}` },
      { appendDescription: '## Affected owners\n\nme' },
    ]) {
      await expect(h.svc.updateChangeRequest(9, user(AUTHOR), input)).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('## Affected owners'),
      });
    }
    // A heading that merely mentions it is the author's own.
    await h.svc.updateChangeRequest(9, user(AUTHOR), { description: '## Affected owners, informally\n\nMine.' });
    expect(h.written).toHaveLength(1);
  });

  it('refuses a replacement and an append together with 400', async () => {
    const h = harness({ authorEmail: AUTHOR });
    await expect(
      h.svc.updateChangeRequest(9, user(AUTHOR), { description: 'a', appendDescription: 'b' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.tx.update).not.toHaveBeenCalled();
  });
});

describe('WorkflowService.updateChangeRequest — what an edit writes', () => {
  it('replaces the author’s text and keeps the generated owners block', async () => {
    const h = harness({ authorEmail: AUTHOR });
    const before = Date.now();
    await h.svc.updateChangeRequest(9, user(AUTHOR, 'Alice'), { description: '  P2 - Planned\n\nNew reason.  ' });
    const [set] = h.written;
    expect(set.body).toBe(`P2 - Planned\n\nNew reason.\n\n${GENERATED}`);
    expect(set).not.toHaveProperty('title');
    expect((set.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('changes the title alone without touching the body', async () => {
    const h = harness({ authorEmail: AUTHOR });
    await h.svc.updateChangeRequest(9, user(AUTHOR), { title: '  New title ' });
    const [set] = h.written;
    expect(set.title).toBe('New title');
    expect(set).not.toHaveProperty('body');
  });

  it('keeps Hexis’s own markers — an access request’s level survives an edit', async () => {
    const h = harness({
      authorEmail: AUTHOR,
      body: '<!--hexis:access-request-level:owner-->\nAlice asked for **Owner** on Docs.',
    });
    await h.svc.updateChangeRequest(9, user(AUTHOR), { description: 'Please, for the Q3 review.' });
    expect(h.written[0].body).toBe('<!--hexis:access-request-level:owner-->\n\nPlease, for the Q3 review.');
  });

  it('appends to the description as stored, keeping the generated owners block', async () => {
    const h = harness({ authorEmail: AUTHOR });
    await h.svc.updateChangeRequest(9, user(AUTHOR), { appendDescription: '  Round two.  ' });
    expect(h.written[0].body).toBe(`Old reason.\n\nRound two.\n\n${GENERATED}`);
  });

  it('reads the body under the row’s lock, in the transaction that writes it, so racing edits serialise', async () => {
    const h = harness({ authorEmail: AUTHOR });
    await h.svc.updateChangeRequest(9, user(AUTHOR), { appendDescription: 'Round two.' });
    expect(h.db.transaction).toHaveBeenCalledTimes(1);
    expect(h.db.select).not.toHaveBeenCalled();
    expect(h.db.update).not.toHaveBeenCalled();
    expect(h.tx.select).toHaveBeenCalledTimes(1);
    expect(h.tx.for).toHaveBeenCalledWith('update');
    expect(h.tx.update).toHaveBeenCalledTimes(1);
    expect(h.written).toHaveLength(1);
    expect(h.emitted).toEqual([{ kind: 'change-request-edited', number: 9 }]);
  });

  it('drops the cached reads and tells every session, so readers see the new text at once', async () => {
    const h = harness({ authorEmail: AUTHOR });
    await h.svc.updateChangeRequest(9, user(AUTHOR), { title: 'New' });
    expect(h.prs.invalidateDetailCache).toHaveBeenCalledWith(9);
    expect(h.emitted).toEqual([{ kind: 'change-request-edited', number: 9 }]);
  });

  it('a merge that won the race refuses the edit with the merged 409', async () => {
    const h = harness({ authorEmail: AUTHOR });
    (h.tx.returning as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (h.prs.getPr as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ state: 'open', authorId: hashEmail(AUTHOR), base: 'main' })
      .mockResolvedValueOnce({ state: 'merged' });
    await expect(h.svc.updateChangeRequest(9, user(AUTHOR), { title: 'New' })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already been applied'),
    });
    expect(h.emitted).toEqual([]);
  });
});
