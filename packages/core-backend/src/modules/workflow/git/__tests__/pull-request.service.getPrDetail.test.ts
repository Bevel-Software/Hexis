import { describe, it, expect, vi } from 'vitest';

import { PullRequestService } from '../pull-request.service.js';
import type { Database } from '../../../database/connection.js';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import type { GitService } from '../git.service.js';
import type { IAccessControl } from '../../../access/access-control.interface.js';

const ROW = {
  id: 'cr-7',
  number: 7,
  sourceBranch: 'alice/feature',
  targetBranch: 'current-company-state',
  title: 'Feature',
  body: '',
  authorEmail: 'alice@bevel.software',
  authorName: 'Alice',
  state: 'open',
  mergedSha: null,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: null,
  closedAt: null,
};

function makeDb(): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [ROW] }),
      }),
    }),
  } as unknown as Database;
}

/**
 * A detail read is the hot path behind every change-request poll, every
 * approval click, and every merge. It resolves the SHAs first (that fetches
 * both refs), so the file list must reuse that fetch rather than fetch the
 * same two refs again, and it must not spend one git subprocess per changed
 * file on patches nothing reads.
 */
describe('PullRequestService.getPrDetail — git work per read', () => {
  it('lists files without a second fetch and without patches', async () => {
    const resolvePrShas = vi.fn(async () => ({ baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40) }));
    const changedFilesForPr = vi.fn(async () => []);
    const git = { resolvePrShas, changedFilesForPr } as unknown as GitService;
    const workspace = {
      findAnyWorkspaceId: async () => 'ws-main',
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    const access = { canWriteAtRef: async () => false } as unknown as IAccessControl;

    const svc = new PullRequestService(makeDb(), workspace, access, git);
    const detail = await svc.getPrDetail(7, { fresh: true });

    expect(detail?.headSha).toBe('h'.repeat(40));
    expect(resolvePrShas).toHaveBeenCalledTimes(1);
    expect(changedFilesForPr).toHaveBeenCalledTimes(1);
    expect(changedFilesForPr).toHaveBeenCalledWith(
      'ws-main',
      'current-company-state',
      'alice/feature',
      { skipFetch: true, patchCap: 0 },
    );
    // The SHAs (and their fetch) come first; the file list rides on it.
    expect(resolvePrShas.mock.invocationCallOrder[0]).toBeLessThan(
      changedFilesForPr.mock.invocationCallOrder[0]!,
    );
  });
});
