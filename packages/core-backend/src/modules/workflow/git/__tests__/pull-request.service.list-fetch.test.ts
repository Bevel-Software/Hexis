import { describe, it, expect, vi } from 'vitest';

import { PullRequestService } from '../pull-request.service.js';
import type { Database } from '../../../database/connection.js';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import type { GitService } from '../git.service.js';
import type { IAccessControl } from '../../../access/access-control.interface.js';

/**
 * What a change-request LIST is allowed to cost.
 *
 * REPRODUCED against a running instance (ticket log, 2026-09-18): a cold
 * `GET /api/workflow/change-requests/for-me?fresh=1` took 1.31s at two open
 * requests and 3.48s at five — about 0.55s more per additional request. The
 * cause is per-request: every summary needs the request's touched paths, and
 * `changedPathsForPr` fetches the two refs it is about before diffing them,
 * so the list paid one NETWORK ROUND TRIP per open request. It is re-read
 * after every proposal and polled every 60s, and the tree asks two list
 * endpoints at once, so the cost landed twice over.
 *
 * The refs still have to be fresh. They are refreshed once for the whole
 * clone instead — `ensureRemotesFetched` is one `git fetch --prune origin`,
 * TTL-cached, sharing an in-flight fetch between callers.
 */

const row = (number: number, sourceBranch: string) => ({
  id: `cr-${number}`,
  number,
  sourceBranch,
  targetBranch: 'main',
  title: `Changes ${number}`,
  body: '',
  authorEmail: 'biz2@bevel.software',
  authorName: 'Biz Two',
  state: 'open',
  mergedSha: null,
  createdAt: new Date('2026-09-18T00:00:00Z'),
  updatedAt: null,
  closedAt: null,
});

function harness(rows = [row(1, 'suggestions/a/knowledge'), row(2, 'suggestions/b/knowledge')]) {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: async () => rows, limit: async () => rows }),
      }),
    }),
  } as unknown as Database;
  const changedPathsForPr = vi.fn(async () => ['Shared/one.pdf']);
  const git = { changedPathsForPr } as unknown as GitService;
  const ensureRemotesFetched = vi.fn(async () => undefined);
  const workspace = {
    findAnyWorkspaceId: async () => 'ws-main',
    ensureRemotesFetched,
  } as unknown as WorkspaceService;
  const access = {
    canWriteBatchAtRef: async (_w: string, _r: string, _e: string, asked: string[]) =>
      new Map(asked.map((p) => [p, true])),
  } as unknown as IAccessControl;
  return {
    svc: new PullRequestService(db, workspace, access, git),
    changedPathsForPr,
    ensureRemotesFetched,
  };
}

describe('the change-request list refreshes the clone once, not once per request', () => {
  it('fetches the clone once and asks for no per-request fetch', async () => {
    const { svc, changedPathsForPr, ensureRemotesFetched } = harness();

    const list = await svc.listOpenPrs({ fresh: true });

    expect(list).toHaveLength(2);
    expect(ensureRemotesFetched).toHaveBeenCalledTimes(1);
    // FORCED on a fresh read, for the reason the read is fresh at all: the
    // caller knows the remote just moved, and a fetch skipped by its own 30s
    // TTL would answer about a request whose branch this clone has not seen.
    expect(ensureRemotesFetched).toHaveBeenCalledWith('ws-main', { force: true });
    // Two requests, two diffs — and neither of them a network round trip.
    expect(changedPathsForPr).toHaveBeenCalledTimes(2);
    for (const call of changedPathsForPr.mock.calls) {
      expect(call[3]).toEqual({ fetch: false });
    }
  });

  it('does not grow its fetch count with the number of open requests', async () => {
    const five = [1, 2, 3, 4, 5].map((n) => row(n, `suggestions/${n}/knowledge`));
    const { svc, ensureRemotesFetched } = harness(five);
    expect(await svc.listOpenPrs({ fresh: true })).toHaveLength(5);
    expect(ensureRemotesFetched).toHaveBeenCalledTimes(1);
  });

  it('touches the network not at all when there is nothing to summarise', async () => {
    const { svc, ensureRemotesFetched, changedPathsForPr } = harness([]);
    expect(await svc.listOpenPrs({ fresh: true })).toEqual([]);
    expect(ensureRemotesFetched).not.toHaveBeenCalled();
    expect(changedPathsForPr).not.toHaveBeenCalled();
  });

  it('leaves the fetch TTL alone for a background poll', async () => {
    const { svc, ensureRemotesFetched } = harness();
    // No `fresh`: nobody said the remote moved, so the clone is refreshed at
    // whatever rate `ensureRemotesFetched` sees fit. (A branch the clone has
    // never heard of is still fetched — `changedPathsForPr` does that for
    // itself, so a poll can be a poll without hiding a request.)
    await svc.listOpenPrs();
    expect(ensureRemotesFetched).toHaveBeenCalledWith('ws-main', { force: false });
  });

  it('still answers when the refresh itself fails — the refs are then as old as the last one', async () => {
    const { svc, changedPathsForPr, ensureRemotesFetched } = harness();
    ensureRemotesFetched.mockRejectedValue(new Error('origin unreachable'));
    // Degrades exactly as the per-request fetch did (it was `.catch(() => undefined)`
    // too): the local refs are used, and a request whose diff cannot be
    // computed reports no touched paths.
    const list = await svc.listOpenPrs({ fresh: true });
    expect(list).toHaveLength(2);
    expect(changedPathsForPr).toHaveBeenCalledTimes(2);
  });
});
