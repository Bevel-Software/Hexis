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

const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);

/**
 * A detail read is the hot path behind every change-request poll, every
 * approval click, and every merge. It resolves the SHAs first (that fetches
 * both refs), so the file list must be pinned to those same commits rather
 * than fetch and resolve again. The SHAs and the file list are read on every
 * call (a new head must show); what the detail cache saves is the DB
 * enrichment (comments, approvals), so that is where "cached" is observed.
 */
describe('PullRequestService.getPrDetail — git work per read', () => {
  function harness() {
    const resolvePrShas = vi.fn(async () => ({ baseSha: BASE, headSha: HEAD }));
    const changedFilesForPr = vi.fn(async () => []);
    const git = { resolvePrShas, changedFilesForPr } as unknown as GitService;
    const workspace = {
      findAnyWorkspaceId: async () => 'ws-main',
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    const access = { canWriteAtRef: async () => false } as unknown as IAccessControl;
    const svc = new PullRequestService(makeDb(), workspace, access, git);
    const listComments = vi.fn(async () => []);
    const getApprovalStates = vi.fn(async () => []);
    svc.setDetailEnricher({
      listComments,
      getApprovalStates,
      evaluateMergeGate: () => ({ mergeable: false, reasons: [], warnings: [] }),
    });
    return { svc, resolvePrShas, changedFilesForPr, getApprovalStates };
  }

  it('pins the file list to the SHAs it just resolved, and keeps patches for a client read', async () => {
    const { svc, resolvePrShas, changedFilesForPr } = harness();
    const detail = await svc.getPrDetail(7, { fresh: true });

    expect(detail?.headSha).toBe(HEAD);
    expect(detail?.baseSha).toBe(BASE);
    expect(resolvePrShas).toHaveBeenCalledTimes(1);
    expect(changedFilesForPr).toHaveBeenCalledTimes(1);
    expect(changedFilesForPr).toHaveBeenCalledWith(
      'ws-main',
      'current-company-state',
      'alice/feature',
      { at: { baseSha: BASE, headSha: HEAD } },
    );
    // The SHAs (and their fetch) come first; the file list rides on it.
    expect(resolvePrShas.mock.invocationCallOrder[0]).toBeLessThan(
      changedFilesForPr.mock.invocationCallOrder[0]!,
    );
  });

  it('a client read is cached: the next plain read skips the enrichment', async () => {
    const { svc, getApprovalStates } = harness();
    await svc.getPrDetail(7, { fresh: true });
    await svc.getPrDetail(7);
    expect(getApprovalStates).toHaveBeenCalledTimes(1);
  });

  it('an internal read (patches: false) skips patches and is not cached', async () => {
    const { svc, changedFilesForPr, getApprovalStates } = harness();
    await svc.getPrDetail(7, { fresh: true, patches: false });
    expect(changedFilesForPr).toHaveBeenLastCalledWith(
      'ws-main',
      'current-company-state',
      'alice/feature',
      { at: { baseSha: BASE, headSha: HEAD }, patchCap: 0 },
    );
    // Not cached: the next plain read enriches again and asks for its own
    // (full) file list.
    await svc.getPrDetail(7);
    expect(getApprovalStates).toHaveBeenCalledTimes(2);
    expect(changedFilesForPr).toHaveBeenLastCalledWith(
      'ws-main',
      'current-company-state',
      'alice/feature',
      { at: { baseSha: BASE, headSha: HEAD } },
    );
  });
});

/**
 * The link on a change request is what an agent hands a person, so it is built
 * from the configured public frontend address — never from the source branch.
 */
describe('PullRequestService — change request link', () => {
  function detailWith(publicFrontendUrl?: string | null) {
    const git = {
      resolvePrShas: async () => ({ baseSha: BASE, headSha: HEAD }),
      changedFilesForPr: async () => [],
    } as unknown as GitService;
    const workspace = {
      findAnyWorkspaceId: async () => 'ws-main',
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    const access = { canWriteAtRef: async () => false } as unknown as IAccessControl;
    const svc = new PullRequestService(makeDb(), workspace, access, git, publicFrontendUrl);
    svc.setDetailEnricher({
      listComments: async () => [],
      getApprovalStates: async () => [],
      evaluateMergeGate: () => ({ mergeable: false, reasons: [], warnings: [] }),
    });
    return svc.getPrDetail(7, { fresh: true });
  }

  it('is absolute under a configured address, with no note', async () => {
    const detail = await detailWith('https://bevel.example.com');
    expect(detail?.number).toBe(7);
    expect(detail?.url).toBe('https://bevel.example.com/change-requests/7');
    expect(detail).not.toHaveProperty('urlNote');
    expect(detail?.url).not.toContain('alice');
    expect(detail?.url).not.toContain('feature');
  });

  it('includes a proxied deployment\'s path prefix', async () => {
    const detail = await detailWith('https://example.com/hexis/');
    expect(detail?.url).toBe('https://example.com/hexis/change-requests/7');
  });

  it('stays relative with a note when no address is configured', async () => {
    const detail = await detailWith(null);
    expect(detail?.number).toBe(7);
    expect(detail?.url).toBe('/change-requests/7');
    expect(detail?.urlNote).toBe('Set PUBLIC_FRONTEND_URL to get absolute links.');
  });
});
