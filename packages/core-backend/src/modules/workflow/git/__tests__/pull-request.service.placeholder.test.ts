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
  function harness() {
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
    const changedPathsForPr = vi.fn(async () => [
      'Reports/.gitkeep',
      'Reports/Empty/.gitkeep',
      'Reports/q3.md',
    ]);
    const git = { changedPathsForPr } as unknown as GitService;
    const workspace = { findAnyWorkspaceId: async () => 'ws-main' } as unknown as WorkspaceService;
    const svc = new PullRequestService(db, workspace, {} as IAccessControl, git);
    return { svc, changedPathsForPr };
  }

  it('listOpenPrs reports only real files as touched paths', async () => {
    const { svc, changedPathsForPr } = harness();
    const [summary] = await svc.listOpenPrs({ fresh: true });
    expect(changedPathsForPr).toHaveBeenCalledTimes(1);
    expect(summary.touchedNodePaths).toEqual(['Reports/q3.md']);
  });
});
