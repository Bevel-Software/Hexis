import { describe, it, expect, vi } from 'vitest';
import { isFolderPlaceholder } from '@bevel-software/platform-shared';

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
    // The real `changedPathPairs` drops the placeholder (it is never a file
    // anybody reads) while the flat list keeps it for the empty-request check,
    // so the double answers both the way the service does. It borrows the
    // production predicate rather than spelling one out: `isFolderPlaceholder`
    // matches on the BASENAME, so a root-level `.gitkeep` is a placeholder too,
    // and both of the real readers drop `roles.yaml`.
    const changedPathsForPr = vi.fn(async () => ({
      paths: paths.filter((p) => p !== 'roles.yaml'),
      pairs: paths
        .filter((p) => !isFolderPlaceholder(p) && p !== 'roles.yaml')
        .map((path) => ({ path })),
    }));
    const git = { changedPathsAndPairsForPr: changedPathsForPr } as unknown as GitService;
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
    // Access was asked about the placeholder, however the lookup is batched.
    expect(canWriteBatchAtRef.mock.calls.some((c) => c[3].includes('Reports/Empty/.gitkeep'))).toBe(true);
  });

  it('a folder-only request outside the viewer\'s scope does not route to them', async () => {
    const { svc } = harness(['Elsewhere/.gitkeep']);
    expect(await svc.listPrsForOwnerEmail('ws-main', 'bob@bevel.software', { fresh: true })).toEqual([]);
  });

  it('a placeholder at the ROOT is a placeholder too, on both views of the summary', async () => {
    // `isFolderPlaceholder` matches the basename, so `.gitkeep` with no folder
    // in front of it is the same non-file — the corner a filter spelled
    // `endsWith('/.gitkeep')` would get wrong on both the paths and the pairs.
    const { svc } = harness(['.gitkeep', 'Reports/q3.md']);
    const [summary] = await svc.listOpenPrs({ fresh: true });
    expect(summary.touchedNodePaths).toEqual(['Reports/q3.md']);
    expect(summary.touchedNodeFiles).toEqual([{ path: 'Reports/q3.md' }]);
  });
});
