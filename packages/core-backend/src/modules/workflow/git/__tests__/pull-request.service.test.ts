import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { PullRequestService, changeSourceFor } from '../pull-request.service.js';
import type { GitService } from '../git.service.js';
import type { Database } from '../../../database/connection.js';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import type { IAccessControl } from '../../../access/access-control.interface.js';
import { hashEmail as hash } from '../../../../shared/email-identity.js';
import { WorkflowValidationError } from '../../../../shared/domain-errors.js';

function pr(overrides: Partial<PullRequestSummary>): PullRequestSummary {
  return {
    number: 1,
    title: 'PR',
    author: { login: 'bot' },
    branch: 'feature/x',
    base: 'current-company-state',
    state: 'open',
    createdAt: '2026-04-01T00:00:00Z',
    touchedNodePaths: [],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: 'https://github.com/acme/repo/pull/1',
    ...overrides,
  };
}

/**
 * (ref, path) → set of emails that have write access at that point in the
 * access tree. Drives the `canWriteBatchAtRef` stub.
 */
type WritersByRefAndPath = Record<string, Record<string, string[]>>;

function makeAccessControl(byRef: WritersByRefAndPath): IAccessControl {
  return {
    canWrite: async () => false,
    canWriteBatch: async () => new Map(),
    canRead: async () => true,
    canReadBatch: async () => new Map(),
    eligibleReaders: async () => ({ restricted: false, roles: [], users: [] }),
    canReadAtRef: async () => null,
    canReadBatchAtRef: async () => null,
    canDownload: async () => false,
    canOwner: async () => false,
    eligibleOwners: async () => ({ roles: [], users: [] }),
    eligibleDownloaders: async () => ({ roles: [], users: [] }),
    eligibleWriters: async () => ({ roles: [], users: [] }),
    eligibleWriterEmails: async () => new Map(),
    eligibleOwnerEmails: async () => new Map(),
    grantSources: async () => ({}),
    invalidate: () => {},
    canWriteAtRef: async () => null,
    canWriteBatchAtRef: async (_ws, ref, userEmail, paths) => {
      const result = new Map<string, boolean>();
      const refMap = byRef[ref];
      if (!refMap) {
        for (const p of paths) result.set(p, false);
        return result;
      }
      const normalized = userEmail.trim().toLowerCase();
      for (const p of paths) {
        const writers = refMap[p] ?? [];
        result.set(p, writers.map((e) => e.toLowerCase()).includes(normalized));
      }
      return result;
    },
    eligibleWritersAtRef: async () => null,
    eligibleWritersForPathsAtRef: async () => null,
    findEmailByHash: async () => null,
    kbPrincipals: async () => ({ plugins: [], people: [] }),
    validateRolesYaml: () => ({ ok: true }),
  };
}

function makeService(
  prs: PullRequestSummary[],
  writers: WritersByRefAndPath,
): { svc: PullRequestService; fetchSpy: ReturnType<typeof vi.fn> } {
  const fetchSpy = vi.fn(async () => undefined);
  const workspace = {
    ensureRemotesFetched: fetchSpy,
    findAnyWorkspaceId: async () => 'ws',
  } as unknown as WorkspaceService;
  // listOpenPrs is mocked below, so the DB + git deps are never exercised
  // through that path. `listPrsForOwnerEmail` (the unit under test) reads
  // pre-built summaries straight from the mock.
  const svc = new PullRequestService(
    {} as unknown as Database,
    workspace,
    makeAccessControl(writers),
    {} as unknown as GitService,
  );
  vi.spyOn(svc, 'listOpenPrs').mockResolvedValue(prs);
  return { svc, fetchSpy };
}

describe('PullRequestService.listPrsForOwnerEmail', () => {
  const USER = 'juan@bevel.software';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty for a blank email without touching git', async () => {
    const { svc, fetchSpy } = makeService([pr({ number: 1 })], {});
    expect(await svc.listPrsForOwnerEmail('ws', '   ')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('includes PRs the user authored even when they have no write access on the touched files', async () => {
    const { svc } = makeService(
      [
        pr({
          number: 1,
          authorId: hash(USER),
          branch: 'feature/mine',
          touchedNodePaths: ['Knowledge/Foo.md'],
        }),
      ],
      {},
    );

    const out = await svc.listPrsForOwnerEmail('ws', USER);
    expect(out.map((p) => p.number)).toEqual([1]);
  });

  it('matches when the PR head broadens access to include the user (base does not)', async () => {
    const { svc } = makeService(
      [
        pr({
          number: 23,
          branch: 'razvan/sme-basket-filter',
          base: 'current-company-state',
          touchedNodePaths: ['Knowledge/Processes/Basket.md'],
        }),
      ],
      {
        'razvan/sme-basket-filter': {
          'Knowledge/Processes/Basket.md': [USER],
        },
        // Base grants no one — empty map.
      },
    );

    const out = await svc.listPrsForOwnerEmail('ws', USER);
    expect(out.map((p) => p.number)).toEqual([23]);
  });

  it('matches when the base branch grants the user write (the PR head removes it)', async () => {
    const { svc } = makeService(
      [
        pr({
          number: 42,
          branch: 'feature/remove-access',
          touchedNodePaths: ['Knowledge/Foo.md'],
        }),
      ],
      {
        'current-company-state': {
          'Knowledge/Foo.md': [USER],
        },
        // Head removed them — no entry.
      },
    );

    const out = await svc.listPrsForOwnerEmail('ws', USER);
    expect(out.map((p) => p.number)).toEqual([42]);
  });

  it('excludes PRs where neither head nor base grants the user write', async () => {
    const { svc } = makeService(
      [
        pr({
          number: 99,
          branch: 'feature/other',
          touchedNodePaths: ['Knowledge/Foo.md'],
        }),
      ],
      {
        'feature/other': { 'Knowledge/Foo.md': ['ali@bevel.software'] },
        'current-company-state': { 'Knowledge/Foo.md': ['ali@bevel.software'] },
      },
    );

    const out = await svc.listPrsForOwnerEmail('ws', USER);
    expect(out).toEqual([]);
  });

  it('is case- and whitespace-insensitive on the user email', async () => {
    const { svc } = makeService(
      [
        pr({
          number: 1,
          touchedNodePaths: ['Knowledge/Foo.md'],
        }),
      ],
      {
        'current-company-state': {
          'Knowledge/Foo.md': ['JUAN@Bevel.Software'],
        },
      },
    );

    const out = await svc.listPrsForOwnerEmail('ws', '  juan@bevel.software  ');
    expect(out.map((p) => p.number)).toEqual([1]);
  });

  it('fetches remote refs once before resolving access, even across many PRs', async () => {
    const { svc, fetchSpy } = makeService(
      [
        pr({ number: 1, branch: 'a', touchedNodePaths: ['Knowledge/Foo.md'] }),
        pr({ number: 2, branch: 'b', touchedNodePaths: ['Knowledge/Bar.md'] }),
      ],
      {},
    );

    await svc.listPrsForOwnerEmail('ws', USER);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('skips access resolution when no PRs are returned', async () => {
    const { svc, fetchSpy } = makeService([], {});
    const out = await svc.listPrsForOwnerEmail('ws', USER);
    expect(out).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * `listPrsByState` — what the agent read tools call so a reader can catch up on
 * requests that have already been applied or declined. The open-only path is
 * delegated (and keeps its cache); every other state set is read from the table.
 */
describe('PullRequestService.listPrsByState', () => {
  /** The merge commit an applied row records, and the one its diff is read from. */
  const MERGE_SHA = 'a'.repeat(40);

  /** A `change_requests` row as drizzle hands it back. */
  function row(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      number: 1,
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      title: 'A proposal',
      body: 'why',
      authorEmail: 'juan@bevel.software',
      authorName: 'Juan',
      state: 'merged',
      mergedSha: MERGE_SHA,
      createdAt: new Date('2026-04-01T00:00:00Z'),
      updatedAt: null,
      closedAt: new Date('2026-04-03T09:30:00Z'),
      applyFailureReason: null,
      applyFailureConflicts: null,
      applyFailedAt: null,
      applyFailedByName: null,
      applyFailureKind: null,
      closedReason: null,
      ...over,
    };
  }

  /** The service over a drizzle-shaped select that answers `rows`. */
  function svcOver(rows: Record<string, unknown>[], changedPaths: string[] = []) {
    const orderBy = vi.fn(async () => rows);
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ orderBy }) }) }));
    const db = { select } as unknown as Database;
    const answer = (paths: string[]) => ({ paths, pairs: paths.map((path) => ({ path })) });
    const ensureRemotesFetched = vi.fn(async () => undefined);
    const workspace = {
      ensureRemotesFetched,
      findAnyWorkspaceId: async () => 'ws',
    } as unknown as WorkspaceService;
    // Both diff paths are stubbed, so a test can prove WHICH one a row's state
    // took — the point of the routing, and of the finding behind it.
    const forPr = vi.fn(async () => answer(changedPaths));
    const atCommit = vi.fn(async () => answer(changedPaths));
    const git = {
      changedPathsAndPairsForPr: forPr,
      changedPathsAndPairsOfAppliedChange: atCommit,
    } as unknown as GitService;
    const svc = new PullRequestService(db, workspace, makeAccessControl({}), git);
    return { svc, select, forPr, atCommit, ensureRemotesFetched };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates the open-only case so the list the app polls keeps its cache', async () => {
    const { svc, select } = svcOver([]);
    const open = [pr({ number: 7 })];
    const spy = vi.spyOn(svc, 'listOpenPrs').mockResolvedValue(open);
    expect(await svc.listPrsByState(['open'])).toBe(open);
    expect(await svc.listPrsByState(['open', 'open'])).toBe(open);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(select).not.toHaveBeenCalled();
  });

  it('answers nothing, and asks nothing, for an empty state set', async () => {
    const { svc, select } = svcOver([row()]);
    expect(await svc.listPrsByState([])).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('reads the closed and merged rows from the table', async () => {
    const { svc, select, atCommit, forPr } = svcOver(
      [row({ number: 9, state: 'merged' })],
      ['Knowledge/A.md'],
    );
    const [summary] = await svc.listPrsByState(['closed', 'merged']);
    expect(select).toHaveBeenCalledTimes(1);
    // The merge commit, not the branch pair: the source branch is retired, so
    // asking for it is what sent one fetch per row at the remote.
    // The ref carries the NUMBER as well as the sha: the git layer refuses a
    // commit that is not this request's own merge commit. And the TITLE, so a
    // commit written in the old message format is recognised too.
    expect(atCommit).toHaveBeenCalledWith('ws', { number: 9, mergeSha: MERGE_SHA, title: 'A proposal' });
    expect(forPr).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      number: 9,
      state: 'merged',
      branch: 'feature/x',
      base: 'main',
      touchedNodePaths: ['Knowledge/A.md'],
    });
    // The close time is the latest moment the row records, so it is `updatedAt`.
    expect(summary.updatedAt).toBe('2026-04-03T09:30:00.000Z');
  });

  it('reads the table for a set that contains `open` ALONGSIDE another state', async () => {
    // Only a deduplicated singleton `['open']` may delegate: a guard loosened to
    // `states.includes('open')` would answer `['open', 'merged']` with the open
    // rows alone and silently drop the merged ones. `listOpenPrs` is spied so
    // delegation would be visible rather than merely wrong.
    const { svc, select } = svcOver([row({ number: 9, state: 'merged' })], ['Knowledge/A.md']);
    const spy = vi.spyOn(svc, 'listOpenPrs').mockResolvedValue([]);
    const summaries = await svc.listPrsByState(['open', 'closed', 'merged']);
    expect(spy).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
    expect(summaries.map((s) => s.number)).toEqual([9]);
  });

  it('falls back to the creation time when the row records nothing later', async () => {
    const { svc } = svcOver([row({ state: 'closed', closedAt: null })]);
    const [summary] = await svc.listPrsByState(['closed']);
    expect(summary.updatedAt).toBe('2026-04-01T00:00:00.000Z');
  });

  // Razvan's review of #347, finding 1: a closed row's branch is retired, so
  // `publishedPrCommits` answered null and the diff FETCHED two refs — one of
  // which no longer exists — once per row, logging a warning for each. A few
  // hundred applied requests opened a few hundred concurrent fetches to answer
  // nothing. Nothing about a closed row needs the network.
  describe('listing closed and merged requests costs at most one fetch, never one per row', () => {
    it('asks for no clone refresh when only declined rows are in scope — they read from nothing', async () => {
      const { svc, ensureRemotesFetched } = svcOver([row({ state: 'closed', mergedSha: null })], ['A.md']);
      await svc.listPrsByState(['closed', 'merged']);
      expect(ensureRemotesFetched).not.toHaveBeenCalled();
    });

    it('refreshes the clone ONCE for a list of merged rows — their commits are immutable, but a clone must hold them', async () => {
      // A clone that has not fetched since the merges would otherwise read
      // every applied request as author-only for good (cubic P1 on #373).
      const { svc, ensureRemotesFetched } = svcOver(
        [row({ number: 1, state: 'merged' }), row({ number: 2, state: 'merged' }), row({ number: 3, state: 'merged' })],
        ['A.md'],
      );
      await svc.listPrsByState(['closed', 'merged']);
      expect(ensureRemotesFetched).toHaveBeenCalledTimes(1);
    });

    it('keeps the ONE refresh for a set that does contain open rows', async () => {
      const { svc, ensureRemotesFetched } = svcOver([row({ state: 'merged' })], ['A.md']);
      vi.spyOn(svc, 'listOpenPrs').mockResolvedValue([]);
      await svc.listPrsByState(['open', 'merged']);
      expect(ensureRemotesFetched).toHaveBeenCalledTimes(1);
    });

    it('remembers a merge commit the clone refused, and does not ask git for it again on the next list', async () => {
      // Rows whose `merged_sha` is not this request's own commit — written
      // before merges recorded their own — fail the verification for good;
      // re-running their git calls on every poll, serialized under the
      // workspace mutex, is what a deployment with hundreds of them paid.
      const { svc, atCommit } = svcOver([row({ number: 9, state: 'merged' })], ['A.md']);
      atCommit.mockRejectedValue(new WorkflowValidationError('commit is not the merge commit of change request #9'));
      const first = await svc.listPrsByState(['closed', 'merged']);
      expect(first[0]?.touchedNodePaths).toEqual([]);
      await svc.listPrsByState(['closed', 'merged']);
      expect(atCommit).toHaveBeenCalledTimes(1);
      // The memo is bounded in time: once it lapses the row is asked again,
      // so a commit the next fetch brought in is read.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + 61_000);
        await svc.listPrsByState(['closed', 'merged']);
        expect(atCommit).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('asks git NOTHING about a declined row — there is no diff to compute', async () => {
      const { svc, forPr, atCommit } = svcOver([row({ state: 'closed' })], ['A.md']);
      const [summary] = await svc.listPrsByState(['closed']);
      expect(forPr).not.toHaveBeenCalled();
      expect(atCommit).not.toHaveBeenCalled();
      // No files resolved, which downstream reads as "nothing proven": a
      // declined request stays readable by its author alone.
      expect(summary.touchedNodePaths).toEqual([]);
      expect(summary.touchedNodeFiles).toEqual([]);
    });

    it('asks git nothing about a merged row that records no merge commit', async () => {
      const { svc, forPr, atCommit } = svcOver(
        [row({ state: 'merged', mergedSha: null })],
        ['A.md'],
      );
      const [summary] = await svc.listPrsByState(['merged']);
      expect(forPr).not.toHaveBeenCalled();
      expect(atCommit).not.toHaveBeenCalled();
      expect(summary.touchedNodePaths).toEqual([]);
    });
  });

  it('degrades to no touched paths when a merge commit this clone lacks cannot be diffed', async () => {
    const orderBy = vi.fn(async () => [row()]);
    const db = {
      select: () => ({ from: () => ({ where: () => ({ orderBy }) }) }),
    } as unknown as Database;
    const workspace = {
      ensureRemotesFetched: vi.fn(async () => undefined),
      findAnyWorkspaceId: async () => 'ws',
    } as unknown as WorkspaceService;
    const git = {
      changedPathsAndPairsOfAppliedChange: vi.fn(async () => {
        throw new WorkflowValidationError(
          `commit ${MERGE_SHA} is not a merge commit in this clone, so it cannot be change request #1's`,
        );
      }),
    } as unknown as GitService;
    const svc = new PullRequestService(db, workspace, makeAccessControl({}), git);
    const [summary] = await svc.listPrsByState(['merged']);
    // Empty, not thrown — and a caller gating on these paths must read an empty
    // set as "cannot prove read access", never as "nothing to protect".
    expect(summary.touchedNodePaths).toEqual([]);
  });
});

/**
 * `getPrDetail` when nothing is left to read the change from. Since the
 * 2026-10-02 decision an applied request is read from its merge commit (see the
 * describe below this one), so what lands here is a row recording no usable sha:
 * one written before `merged_sha` was, or a declined one.
 *
 * A declined row no longer even TRIES the branch pair — `changeSourceFor` sends
 * it nowhere, so the throwing stub below is never reached for it. That is the
 * point: a declined request's branch is usually alive, so a suite that can only
 * make the branch throw cannot see what such a request actually answers. The
 * describe two below this one drives the live-branch case.
 */
describe('PullRequestService.getPrDetail with a retired branch and no merge commit', () => {
  function svcFor(state: string) {
    const row = {
      number: 4,
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      title: 'A proposal',
      body: 'why it was needed',
      authorEmail: 'juan@bevel.software',
      authorName: 'Juan',
      state,
      createdAt: new Date('2026-04-01T00:00:00Z'),
      updatedAt: null,
      closedAt: new Date('2026-04-03T09:30:00Z'),
      applyFailureReason: null,
      applyFailureConflicts: null,
      applyFailedAt: null,
      applyFailedByName: null,
      applyFailureKind: null,
      closedReason: null,
    };
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
    } as unknown as Database;
    const workspace = {
      ensureRemotesFetched: async () => undefined,
      findAnyWorkspaceId: async () => 'ws',
    } as unknown as WorkspaceService;
    const git = {
      resolvePrShas: async () => {
        throw new WorkflowValidationError('unknown branch: feature/x');
      },
    } as unknown as GitService;
    return new PullRequestService(db, workspace, makeAccessControl({}), git);
  }

  it('answers an applied request from its row alone, rather than failing', async () => {
    const detail = await svcFor('merged').getPrDetail(4);
    expect(detail).toMatchObject({
      number: 4,
      state: 'merged',
      title: 'A proposal',
      body: 'why it was needed',
      files: [],
      headSha: '',
      baseSha: '',
      mergeBaseSha: null,
      behind: false,
      needsUpdate: false,
    });
  });

  it('answers a withdrawn request the same way', async () => {
    expect(await svcFor('closed').getPrDetail(4)).toMatchObject({ state: 'closed', files: [] });
  });

  it('still fails loudly on an OPEN request, so no live proposal reads as empty', async () => {
    await expect(svcFor('open').getPrDetail(4)).rejects.toThrow('unknown branch');
  });
});

/**
 * An APPLIED request is read from the merge commit its row records (Razvan's
 * decision, 2026-10-02). Its branch is retired, so reading it from the branch
 * pair answered no files — and since an empty file set proves no read access,
 * that made every applied request readable by its author alone. Catching up on
 * what happened is what the ticket exists for.
 */
describe('PullRequestService.getPrDetail of an applied request', () => {
  const MERGE_SHA = 'c'.repeat(40);
  const BASE_SHA = '1'.repeat(40);
  const HEAD_SHA = '2'.repeat(40);

  function svcFor(over: Record<string, unknown> = {}) {
    const row = {
      number: 4,
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      title: 'A proposal',
      body: 'why it was needed',
      authorEmail: 'juan@bevel.software',
      authorName: 'Juan',
      state: 'merged',
      mergedSha: MERGE_SHA,
      createdAt: new Date('2026-04-01T00:00:00Z'),
      updatedAt: null,
      closedAt: new Date('2026-04-03T09:30:00Z'),
      applyFailureReason: null,
      applyFailureConflicts: null,
      applyFailedAt: null,
      applyFailedByName: null,
      applyFailureKind: null,
      closedReason: null,
      ...over,
    };
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
    } as unknown as Database;
    const ensureRemotesFetched = vi.fn(async () => undefined);
    const workspace = {
      ensureRemotesFetched,
      findAnyWorkspaceId: async () => 'ws',
    } as unknown as WorkspaceService;
    const resolvePrShas = vi.fn(async () => {
      throw new WorkflowValidationError('unknown branch: feature/x');
    });
    const appliedChangeShas = vi.fn(async () => ({ baseSha: BASE_SHA, headSha: HEAD_SHA }));
    const changedFilesOfAppliedChange = vi.fn(async () => [
      {
        path: 'Knowledge/A.md',
        previousPath: undefined,
        status: 'modified' as const,
        additions: 2,
        deletions: 1,
        patch: '@@ -1 +1 @@',
        isBinary: false,
        sha: '',
        rawUrl: '',
      },
    ]);
    const git = {
      resolvePrShas,
      appliedChangeShas,
      changedFilesOfAppliedChange,
    } as unknown as GitService;
    const svc = new PullRequestService(db, workspace, makeAccessControl({}), git);
    return {
      svc,
      resolvePrShas,
      appliedChangeShas,
      changedFilesOfAppliedChange,
      ensureRemotesFetched,
    };
  }

  it('reads its files from the merge commit, and never asks for its branches', async () => {
    const { svc, resolvePrShas, changedFilesOfAppliedChange } = svcFor();
    const detail = await svc.getPrDetail(4);
    expect(changedFilesOfAppliedChange).toHaveBeenCalledWith('ws', { number: 4, mergeSha: MERGE_SHA, title: 'A proposal' }, {});
    // Not one branch resolution, so not one fetch: the branch no longer exists
    // and the commit cannot change.
    expect(resolvePrShas).not.toHaveBeenCalled();
    expect(detail).toMatchObject({
      number: 4,
      state: 'merged',
      files: [{ path: 'Knowledge/A.md', additions: 2, deletions: 1 }],
    });
  });

  it("reports the merge commit's two parents as the request's base and head", async () => {
    // `headSha` is not decoration: an approval is called stale when the head it
    // was given against is not this one, so answering the merge commit here would
    // report every approval the request ever collected as stale.
    const { svc } = svcFor();
    expect(await svc.getPrDetail(4)).toMatchObject({ baseSha: BASE_SHA, headSha: HEAD_SHA });
  });

  it('asks no "is it behind its target" question of an applied request', async () => {
    const { svc } = svcFor();
    expect(await svc.getPrDetail(4)).toMatchObject({
      mergeBaseSha: null,
      behind: false,
      needsUpdate: false,
    });
  });

  it('skips the patches when the caller asked for none', async () => {
    const { svc, changedFilesOfAppliedChange } = svcFor();
    await svc.getPrDetail(4, { patches: false });
    expect(changedFilesOfAppliedChange).toHaveBeenCalledWith(
      'ws',
      { number: 4, mergeSha: MERGE_SHA, title: 'A proposal' },
      { patchCap: 0 },
    );
  });

  it('falls back to the row alone when this clone does not hold the merge commit', async () => {
    const { svc } = svcFor();
    const git = (svc as unknown as { gitService: Record<string, unknown> }).gitService;
    git.appliedChangeShas = async () => {
      throw new WorkflowValidationError(`no first parent for commit ${MERGE_SHA}`);
    };
    // Fail-closed, as before the decision: no files, so author-only — never
    // somebody else's file list.
    expect(await svc.getPrDetail(4)).toMatchObject({ state: 'merged', files: [], headSha: '' });
  });
});

/**
 * A DECLINED request whose source branch is STILL ALIVE — the case the suite
 * could not see, and the one Local Testing failed on.
 *
 * Declining a change request does not retire its branch; only merging deletes
 * it. So `resolvePrShas` and `changedFilesForPr` answer a declined request
 * perfectly well, and `getPrDetail` used to let them: its file list made the
 * request readable by anyone who could read one of those files, against the
 * owner's criterion that a declined request stays readable by its author alone,
 * while `listPrsByState` — which asks git nothing about a declined row — hid the
 * very same request from the very same caller. The earlier test for this stubbed
 * `resolvePrShas` to THROW, pinning a precondition the service does not produce;
 * here the branch resolves, which is what actually happens.
 */
describe('PullRequestService.getPrDetail of a declined request whose branch still resolves', () => {
  const BASE_SHA = '3'.repeat(40);
  const HEAD_SHA = '4'.repeat(40);

  function svcFor(state: string) {
    const row = {
      number: 9,
      sourceBranch: 'feature/declined',
      targetBranch: 'main',
      title: 'A proposal that was turned down',
      body: 'why it was asked for',
      authorEmail: 'juan@bevel.software',
      authorName: 'Juan',
      state,
      mergedSha: null,
      createdAt: new Date('2026-04-01T00:00:00Z'),
      updatedAt: null,
      closedAt: state === 'open' ? null : new Date('2026-04-03T09:30:00Z'),
      applyFailureReason: null,
      applyFailureConflicts: null,
      applyFailedAt: null,
      applyFailedByName: null,
      applyFailureKind: null,
      closedReason: null,
    };
    const orderBy = vi.fn(async () => [row]);
    const db = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [row], orderBy }) }),
      }),
    } as unknown as Database;
    const ensureRemotesFetched = vi.fn(async () => undefined);
    const workspace = {
      ensureRemotesFetched,
      findAnyWorkspaceId: async () => 'ws',
    } as unknown as WorkspaceService;
    // The branch pair RESOLVES — the whole point. A stub that threw would prove
    // nothing about a declined request, because a live branch does not throw.
    const resolvePrShas = vi.fn(async () => ({ baseSha: BASE_SHA, headSha: HEAD_SHA }));
    const changedFilesForPr = vi.fn(async () => [
      {
        path: 'KnowledgeBase/Readable.md',
        previousPath: undefined,
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@',
        isBinary: false,
        sha: '',
        rawUrl: '',
      },
    ]);
    const changedPathsAndPairsForPr = vi.fn(async () => ({
      paths: ['KnowledgeBase/Readable.md'],
      pairs: [{ path: 'KnowledgeBase/Readable.md' }],
    }));
    const forkPointForPr = vi.fn(async () => ({ mergeBaseSha: BASE_SHA, behind: false }));
    const git = {
      resolvePrShas,
      changedFilesForPr,
      changedPathsAndPairsForPr,
      forkPointForPr,
    } as unknown as GitService;
    const svc = new PullRequestService(db, workspace, makeAccessControl({}), git);
    return { svc, resolvePrShas, changedFilesForPr, changedPathsAndPairsForPr, forkPointForPr };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('answers from the row alone, though the branch pair would have answered', async () => {
    const { svc, resolvePrShas, changedFilesForPr, forkPointForPr } = svcFor('closed');
    const detail = await svc.getPrDetail(9);
    expect(detail).toMatchObject({
      number: 9,
      state: 'closed',
      title: 'A proposal that was turned down',
      // The row's own prose survives; only the file list goes.
      body: 'why it was asked for',
      files: [],
      headSha: '',
      baseSha: '',
    });
    // Not asked, so a declined request cannot publish a file list — and cannot
    // publish the branch's CURRENT diff as the proposal that was turned down,
    // which is what it did while the author kept committing to that branch.
    expect(resolvePrShas).not.toHaveBeenCalled();
    expect(changedFilesForPr).not.toHaveBeenCalled();
    expect(forkPointForPr).not.toHaveBeenCalled();
  });

  it('costs no network round trip per by-number read', async () => {
    // Three reads of a declined request spent three two-ref fetches before this
    // — the per-request network call finding 1 of the review was about, removed
    // from the list path but left on the by-number one.
    const { svc, resolvePrShas, changedFilesForPr } = svcFor('closed');
    await svc.getPrDetail(9, { fresh: true });
    await svc.getPrDetail(9, { fresh: true });
    await svc.getPrDetail(9, { fresh: true });
    expect(resolvePrShas).not.toHaveBeenCalled();
    expect(changedFilesForPr).not.toHaveBeenCalled();
  });

  it('agrees with the list about which files a declined request has', async () => {
    // The contradiction itself: one caller, one request, two surfaces. Both
    // answer "no files proven", so both make it author-only.
    const { svc } = svcFor('closed');
    const detail = await svc.getPrDetail(9);
    const [summary] = await svc.listPrsByState(['closed']);
    expect(detail?.files).toEqual([]);
    expect(summary.touchedNodeFiles).toEqual([]);
    expect(summary.touchedNodePaths).toEqual([]);
  });

  it('still reads an OPEN request from the very same live branch pair', async () => {
    // The control: the stubs DO answer, so the declined case above is the
    // routing refusing to ask, not a stub that could not have replied.
    const { svc, resolvePrShas, changedFilesForPr } = svcFor('open');
    const detail = await svc.getPrDetail(9);
    expect(resolvePrShas).toHaveBeenCalled();
    expect(changedFilesForPr).toHaveBeenCalled();
    expect(detail).toMatchObject({
      state: 'open',
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      files: [{ path: 'KnowledgeBase/Readable.md' }],
    });
  });
});

/**
 * The routing itself, asked once and shared: the list and the by-number detail
 * both read a row's change from whatever this answers, so neither can drift
 * into its own reading of which files a request has.
 */
describe('changeSourceFor', () => {
  it('reads an open request from its branch pair', () => {
    expect(changeSourceFor({ number: 9, state: 'open', mergedSha: null })).toEqual({
      kind: 'branches',
    });
  });

  // The NUMBER travels with the sha, and that is not decoration: the git layer
  // refuses a commit whose subject does not name this request, because a merge
  // with nothing to merge used to record the target tip — usually another
  // request's merge commit (cubic P1 on #347).
  it("reads an applied request from the merge commit its row records, named by number", () => {
    const sha = 'f'.repeat(40);
    expect(changeSourceFor({ number: 9, state: 'merged', mergedSha: sha })).toEqual({
      kind: 'commit',
      applied: { number: 9, mergeSha: sha },
    });
  });

  it('reads a declined request from nothing — no sha records what it proposed', () => {
    expect(changeSourceFor({ number: 9, state: 'closed', mergedSha: null })).toEqual({
      kind: 'none',
    });
  });

  it('reads a declined request from nothing even if a sha somehow sits on the row', () => {
    // A row flipped to `closed` after an apply recorded a sha would otherwise
    // publish a merge commit as a declined request's content.
    expect(changeSourceFor({ number: 9, state: 'closed', mergedSha: 'e'.repeat(40) })).toEqual({
      kind: 'none',
    });
  });

  it('reads a merged row recording no merge commit from nothing', () => {
    expect(changeSourceFor({ number: 9, state: 'merged', mergedSha: null })).toEqual({
      kind: 'none',
    });
    expect(changeSourceFor({ number: 9, state: 'merged' })).toEqual({ kind: 'none' });
  });

  it('reads a state it has never heard of from nothing, rather than guessing', () => {
    expect(changeSourceFor({ number: 9, state: 'draft', mergedSha: 'd'.repeat(40) })).toEqual({
      kind: 'none',
    });
  });
});
