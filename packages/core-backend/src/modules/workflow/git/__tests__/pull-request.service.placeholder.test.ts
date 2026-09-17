import { describe, it, expect, vi } from 'vitest';

import { PullRequestService } from '../pull-request.service.js';
import type { Database } from '../../../database/connection.js';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import type { GitService } from '../git.service.js';
import type { IAccessControl } from '../../../access/access-control.interface.js';

const ROW = {
  id: 'cr-9',
  number: 9,
  sourceBranch: 'alice/new-folders',
  targetBranch: 'current-company-state',
  title: 'Folders',
  body: '',
  authorEmail: 'alice@bevel.software',
  authorName: 'Alice',
  state: 'open',
  mergedSha: null,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: null,
  closedAt: null,
};

/**
 * The empty-folder placeholder is never content, so the change-request LIST
 * (the summaries every "for me" view counts and routes by) leaves it out, just
 * as the detail's file list does. The raw `changedPathsForPr` keeps it — that
 * is the authoritative empty-request check, and is not what a list shows.
 */
describe('PullRequestService summaries — folder placeholder', () => {
  function harness(paths: string[] = ['Reports/.gitkeep', 'Reports/Empty/.gitkeep', 'Reports/q3.md']) {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => [ROW],
            limit: async () => [ROW],
          }),
        }),
      }),
    } as unknown as Database;
    const changedPathsForPr = vi.fn(async () => paths);
    const git = { changedPathsForPr } as unknown as GitService;
    const workspace = {
      findAnyWorkspaceId: async () => 'ws-main',
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    // Bob may write under `Reports/` and nowhere else.
    const canWriteBatchAtRef = vi.fn(async (_ws: string, _ref: string, _email: string, asked: string[]) =>
      new Map(asked.map((p) => [p, p.startsWith('Reports/')])),
    );
    const access = { canWriteBatchAtRef } as unknown as IAccessControl;
    const svc = new PullRequestService(db, workspace, access, git);
    return { svc, changedPathsForPr, canWriteBatchAtRef };
  }

  it('listOpenPrs reports only real files as touched paths', async () => {
    const { svc, changedPathsForPr } = harness();
    const [summary] = await svc.listOpenPrs({ fresh: true });
    expect(changedPathsForPr).toHaveBeenCalledTimes(1);
    expect(summary.touchedNodePaths).toEqual(['Reports/q3.md']);
  });

  it('a request that only creates a folder still routes to the folder\'s owners', async () => {
    const { svc, canWriteBatchAtRef } = harness(['Reports/Empty/.gitkeep']);
    const [routed] = await svc.listPrsForOwnerEmail('ws-main', 'bob@bevel.software', { fresh: true });
    expect(routed?.number).toBe(9);
    // Routed by the placeholder, but never showing it.
    expect(routed.touchedNodePaths).toEqual([]);
    expect(canWriteBatchAtRef.mock.calls.map((c) => c[3])).toEqual([['Reports/Empty/.gitkeep'], ['Reports/Empty/.gitkeep']]);
  });

  it('a folder-only request outside the viewer\'s scope does not route to them', async () => {
    const { svc } = harness(['Elsewhere/.gitkeep']);
    expect(await svc.listPrsForOwnerEmail('ws-main', 'bob@bevel.software', { fresh: true })).toEqual([]);
  });
});
