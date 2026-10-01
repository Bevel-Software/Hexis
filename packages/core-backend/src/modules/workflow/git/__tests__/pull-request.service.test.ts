import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { PullRequestService } from '../pull-request.service.js';
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
    const workspace = {
      ensureRemotesFetched: vi.fn(async () => undefined),
      findAnyWorkspaceId: async () => 'ws',
    } as unknown as WorkspaceService;
    const git = {
      changedPathsAndPairsForPr: vi.fn(async () => ({
        paths: changedPaths,
        pairs: changedPaths.map((path) => ({ path })),
      })),
    } as unknown as GitService;
    const svc = new PullRequestService(db, workspace, makeAccessControl({}), git);
    return { svc, select };
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
    const { svc, select } = svcOver([row({ number: 9, state: 'merged' })], ['Knowledge/A.md']);
    const [summary] = await svc.listPrsByState(['closed', 'merged']);
    expect(select).toHaveBeenCalledTimes(1);
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

  it('falls back to the creation time when the row records nothing later', async () => {
    const { svc } = svcOver([row({ state: 'closed', closedAt: null })]);
    const [summary] = await svc.listPrsByState(['closed']);
    expect(summary.updatedAt).toBe('2026-04-01T00:00:00.000Z');
  });

  it('degrades to no touched paths when a retired branch makes the diff uncomputable', async () => {
    const orderBy = vi.fn(async () => [row()]);
    const db = {
      select: () => ({ from: () => ({ where: () => ({ orderBy }) }) }),
    } as unknown as Database;
    const workspace = {
      ensureRemotesFetched: vi.fn(async () => undefined),
      findAnyWorkspaceId: async () => 'ws',
    } as unknown as WorkspaceService;
    const git = {
      changedPathsAndPairsForPr: vi.fn(async () => {
        throw new Error('unknown branch');
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
 * `getPrDetail` when the two branches can no longer be diffed — the state every
 * applied request ends in, since merging retires its source branch.
 */
describe('PullRequestService.getPrDetail with a retired branch', () => {
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
