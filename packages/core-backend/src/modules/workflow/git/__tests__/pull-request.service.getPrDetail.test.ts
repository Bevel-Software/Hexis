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
const FORK = 'c'.repeat(40);

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
    const forkPointForPr = vi.fn(async () => ({ mergeBaseSha: FORK, behind: true }));
    const pathsChangedBetween = vi.fn(async () => []);
    const git = {
      resolvePrShas,
      changedFilesForPr,
      forkPointForPr,
      pathsChangedBetween,
    } as unknown as GitService;
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
    return {
      svc,
      resolvePrShas,
      changedFilesForPr,
      forkPointForPr,
      pathsChangedBetween,
      getApprovalStates,
    };
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

  it('carries the fork point and "needs updating", pinned to the same SHAs as the file list', async () => {
    const { svc, forkPointForPr } = harness();
    const detail = await svc.getPrDetail(7, { fresh: true });
    expect(forkPointForPr).toHaveBeenCalledWith('ws-main', { baseSha: BASE, headSha: HEAD });
    expect(detail?.mergeBaseSha).toBe(FORK);
    expect(detail?.behind).toBe(true);
    // Anonymous read: no viewer, no Update.
    expect(detail?.viewerCanUpdate).toBe(false);
  });

  it('the target moving on invalidates a cached detail, even with the head unchanged', async () => {
    const { svc, resolvePrShas, getApprovalStates } = harness();
    await svc.getPrDetail(7, { fresh: true });
    resolvePrShas.mockResolvedValueOnce({ baseSha: 'd'.repeat(40), headSha: HEAD });
    await svc.getPrDetail(7);
    expect(getApprovalStates).toHaveBeenCalledTimes(2);
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
      forkPointForPr: async () => ({ mergeBaseSha: FORK, behind: false }),
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

/**
 * `needsUpdate` — the answer the dialog acts on, as distinct from `behind`.
 *
 * `behind` is the honest git fact that the two branches have diverged. On a
 * knowledge base where every shared save commits to the default branch it is
 * true again minutes after every update, and acting on it made opening a
 * request pay for a merge on almost every open — for changes to files the
 * request does not contain. `needsUpdate` adds the half that matters: the
 * target changed a file THIS request also changes.
 */
describe('PullRequestService.getPrDetail — needsUpdate', () => {
  const FILE = 'Sales/Deal.md';
  const OTHER = 'Ops/Runbook.md';

  function harness(opts: {
    behind?: boolean;
    mergeBaseSha?: string | null;
    files?: { path: string; previousPath?: string }[];
    changedOnTarget?: string[];
    changedOnTargetError?: Error;
    state?: string;
  } = {}) {
    const resolvePrShas = vi.fn(async () => ({ baseSha: BASE, headSha: HEAD }));
    const changedFilesForPr = vi.fn(async () => (opts.files ?? [{ path: FILE }]) as never);
    const forkPointForPr = vi.fn(async () => ({
      mergeBaseSha: opts.mergeBaseSha === undefined ? FORK : opts.mergeBaseSha,
      behind: opts.behind ?? true,
    }));
    const pathsChangedBetween = opts.changedOnTargetError
      ? vi.fn().mockRejectedValue(opts.changedOnTargetError)
      : vi.fn(async () => opts.changedOnTarget ?? []);
    const git = {
      resolvePrShas,
      changedFilesForPr,
      forkPointForPr,
      pathsChangedBetween,
    } as unknown as GitService;
    const workspace = {
      findAnyWorkspaceId: async () => 'ws-main',
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    const access = { canWriteAtRef: async () => false } as unknown as IAccessControl;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ ...ROW, state: opts.state ?? 'open' }] }),
        }),
      }),
    } as unknown as Database;
    const svc = new PullRequestService(db, workspace, access, git);
    svc.setDetailEnricher({
      listComments: async () => [],
      getApprovalStates: async () => [],
      evaluateMergeGate: () => ({ mergeable: false, reasons: [], warnings: [] }),
    });
    return { svc, pathsChangedBetween };
  }

  it('is false when the target moved in files this request does not change', async () => {
    // The case that made the message appear on essentially every open: a
    // shared save somewhere else in the knowledge base.
    const h = harness({ files: [{ path: FILE }], changedOnTarget: [OTHER] });
    const detail = await h.svc.getPrDetail(7, { fresh: true });
    expect(detail?.behind).toBe(true);
    expect(detail?.needsUpdate).toBe(false);
  });

  it('is true when the target changed a file this request also changes', async () => {
    const h = harness({ files: [{ path: FILE }], changedOnTarget: [OTHER, FILE] });
    const detail = await h.svc.getPrDetail(7, { fresh: true });
    expect(detail?.needsUpdate).toBe(true);
    // Intersected over the fork point → the target's tip: the same two
    // commits the rest of the detail is pinned to.
    expect(h.pathsChangedBetween).toHaveBeenCalledWith('ws-main', FORK, BASE);
  });

  it('asks git nothing at all when the request is not behind', async () => {
    // The common case, and the one that has to stay free.
    const h = harness({ behind: false });
    const detail = await h.svc.getPrDetail(7, { fresh: true });
    expect(detail?.needsUpdate).toBe(false);
    expect(h.pathsChangedBetween).not.toHaveBeenCalled();
  });

  it('asks git nothing when the request changes no files', async () => {
    const h = harness({ files: [], changedOnTarget: [FILE] });
    const detail = await h.svc.getPrDetail(7, { fresh: true });
    expect(detail?.needsUpdate).toBe(false);
    expect(h.pathsChangedBetween).not.toHaveBeenCalled();
  });

  it('counts a file the target RENAMED, under either of its names', async () => {
    // `pathsChangedBetween` runs without rename detection, so the target's
    // rename reports the path it left as well as the one it arrived at — and
    // a request still editing the old name is affected.
    const h = harness({
      files: [{ path: FILE }],
      changedOnTarget: [FILE, 'Sales/Deal-2026.md'],
    });
    expect((await h.svc.getPrDetail(7, { fresh: true }))?.needsUpdate).toBe(true);
  });

  it('counts a file THIS request renamed, under the name it came from', async () => {
    const h = harness({
      files: [{ path: 'Sales/Deal-final.md', previousPath: FILE }],
      changedOnTarget: [FILE],
    });
    expect((await h.svc.getPrDetail(7, { fresh: true }))?.needsUpdate).toBe(true);
  });

  it('is true when the branches share no history — there is nothing to intersect', async () => {
    const h = harness({ mergeBaseSha: null });
    const detail = await h.svc.getPrDetail(7, { fresh: true });
    expect(detail?.needsUpdate).toBe(true);
    expect(h.pathsChangedBetween).not.toHaveBeenCalled();
  });

  it('is true when the comparison itself fails — an infra error is not "this is fine"', async () => {
    const h = harness({ changedOnTargetError: new Error('git exploded') });
    expect((await h.svc.getPrDetail(7, { fresh: true }))?.needsUpdate).toBe(true);
  });

  it('is false for a request that is not open, whatever git says', async () => {
    const h = harness({ state: 'merged', changedOnTarget: [FILE] });
    const detail = await h.svc.getPrDetail(7, { fresh: true });
    expect(detail?.needsUpdate).toBe(false);
    expect(detail?.behind).toBe(false);
  });
});
