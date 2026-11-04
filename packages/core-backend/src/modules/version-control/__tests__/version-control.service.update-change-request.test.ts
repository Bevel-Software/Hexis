import { describe, it, expect, vi } from 'vitest';
import type { AuthUser, VersionControlEventPayload } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';
import { hashEmail } from '../../../shared/email-identity.js';
import type { Database } from '../../database/connection.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IChangeRequestReviewService } from '../change-request-review/change-request-review.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import type { VersionControlEventBus } from '../event-bus.js';
import { VersionControlService } from '../version-control.service.js';

/**
 * Who may change an open request's title and description: its author, or
 * anyone who may merge it — an admin (write on `roles.yaml` at the base), or
 * the holder of write on every file it changes. Everyone else is refused in
 * words (403), and so is a request that is no longer open (409). These pin
 * that rule and what an allowed edit writes.
 */

const AUTHOR = 'alice@example.com';
const OTHER = 'mallory@example.com';

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
    for: vi.fn(async () => (state === 'open' ? [{ body: opts.body ?? 'Old reason.' }] : [])),
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
  const emitted: VersionControlEventPayload[] = [];
  const events = { emit: (e: VersionControlEventPayload) => emitted.push(e) } as unknown as VersionControlEventBus;

  const svc = new VersionControlService(
    db as unknown as Database,
    {} as GitService,
    prs,
    {} as IChangeRequestReviewService,
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

describe('VersionControlService.updateChangeRequest — who may edit', () => {
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
    expect(h.workspaces.ensureRemotesFetched).toHaveBeenCalledWith('main', { strict: true, force: true });
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

  it('refuses a description past 64,000 characters with 400, on a replacement and on what an append would leave', async () => {
    const h = harness({ authorEmail: AUTHOR, body: 'x'.repeat(63_990) });
    await h.svc.updateChangeRequest(9, user(AUTHOR), { description: 'y'.repeat(64_000) });
    await expect(h.svc.updateChangeRequest(9, user(AUTHOR), { description: 'y'.repeat(64_001) })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('at most 64000 characters'),
    });
    // 63,990 stored + the two newlines + 9 = 64,001: measured on what the
    // append leaves, inside the transaction, and nothing is written.
    await expect(h.svc.updateChangeRequest(9, user(AUTHOR), { appendDescription: 'z'.repeat(9) })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('at most 64000 characters'),
    });
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

describe('VersionControlService.openChangeRequest — the same ceiling on the description', () => {
  it('refuses a description past 64,000 characters with 400 before touching a workspace', async () => {
    const h = harness({ authorEmail: AUTHOR });
    await expect(
      h.svc.openChangeRequest('ws', user(AUTHOR), {
        sourceBranch: 'mallory/draft',
        targetBranch: 'main',
        title: 'Too long',
        description: 'y'.repeat(64_001),
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('at most 64000 characters') });
    expect(h.workspaces.getOrCreateForBranch).not.toHaveBeenCalled();
  });
});

describe('VersionControlService.updateChangeRequest — what an edit writes', () => {
  it('replaces the body whole — the body is the description and nothing else', async () => {
    const h = harness({ authorEmail: AUTHOR });
    const before = Date.now();
    await h.svc.updateChangeRequest(9, user(AUTHOR, 'Alice'), { description: '  P2 - Planned\n\nNew reason.  ' });
    const [set] = h.written;
    expect(set.body).toBe('P2 - Planned\n\nNew reason.');
    expect(set).not.toHaveProperty('title');
    expect((set.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("keeps the author's own headings: nothing in a body is Hexis's to cut", async () => {
    const h = harness({ authorEmail: AUTHOR });
    await h.svc.updateChangeRequest(9, user(AUTHOR), { description: 'Lead.\n\n## Affected owners\n\nI mean the GTM ones.' });
    expect(h.written[0].body).toBe('Lead.\n\n## Affected owners\n\nI mean the GTM ones.');
  });

  it('changes the title alone without touching the body', async () => {
    const h = harness({ authorEmail: AUTHOR });
    await h.svc.updateChangeRequest(9, user(AUTHOR), { title: '  New title ' });
    const [set] = h.written;
    expect(set.title).toBe('New title');
    expect(set).not.toHaveProperty('body');
  });

  it("never touches an access request's level or note — they are columns, not prose", async () => {
    const h = harness({ authorEmail: AUTHOR, body: 'Alice asked for **Owner** on Docs.' });
    await h.svc.updateChangeRequest(9, user(AUTHOR), { description: 'Please, for the Q3 review.' });
    const [set] = h.written;
    expect(set.body).toBe('Please, for the Q3 review.');
    expect(set).not.toHaveProperty('accessRequestLevel');
    expect(set).not.toHaveProperty('accessRequestNote');
  });

  it('appends to the description as stored', async () => {
    const h = harness({ authorEmail: AUTHOR });
    await h.svc.updateChangeRequest(9, user(AUTHOR), { appendDescription: '  Round two.  ' });
    expect(h.written[0].body).toBe('Old reason.\n\nRound two.');
  });

  it('an append to an empty description is the description', async () => {
    const h = harness({ authorEmail: AUTHOR, body: '' });
    await h.svc.updateChangeRequest(9, user(AUTHOR), { appendDescription: 'P1 - High' });
    expect(h.written[0].body).toBe('P1 - High');
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
