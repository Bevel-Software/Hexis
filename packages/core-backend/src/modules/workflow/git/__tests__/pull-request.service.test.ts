import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { PullRequestService } from '../pull-request.service.js';
import type { GitService } from '../git.service.js';
import type { Database } from '../../../database/connection.js';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import type { IAccessControl } from '../../../access/access-control.interface.js';
import { hashEmail as hash } from '../../../../shared/hash-email.js';

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
    kbPrincipals: async () => ({ groups: [], people: [] }),
    validateRolesYaml: () => ({ ok: true }),
    referencesToRole: async () => [],
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
