import { describe, it, expect, vi } from 'vitest';
import { PullRequestService, applierName } from '../pull-request.service.js';
import type { GitService } from '../git.service.js';
import type { Database } from '../../../database/connection.js';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import type { IAccessControl } from '../../../access/access-control.interface.js';
import { prMergeLog } from '../../../database/schema.js';
import { AppliedChangeMismatchError } from '../../../../shared/domain-errors.js';

/**
 * A finished request's detail says how it ended (hx-finished-request-says-so):
 * when, who applied it (display name only), the one recorded close reason, and
 * the request's OWN verified merge commit for the "as applied" reads.
 */

const MERGE_SHA = 'c'.repeat(40);
const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const CLOSED_AT = new Date('2026-10-10T09:30:00Z');

interface MergeLogRow {
  name: string;
}

function harness(
  over: Record<string, unknown> = {},
  opts: { mergeLog?: MergeLogRow[]; mismatch?: boolean; mergeLogThrows?: boolean } = {},
) {
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
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: null,
    closedAt: CLOSED_AT,
    applyFailureReason: null,
    applyFailureConflicts: null,
    applyFailedAt: null,
    applyFailedByName: null,
    applyFailureKind: null,
    closedReason: null,
    ...over,
  };
  const mergeLogWhere = vi.fn();
  const db = {
    select: (cols?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table === prMergeLog) {
          // Only the name column may be asked for: the email beside it is
          // never read by the finished facts.
          expect(Object.keys(cols ?? {})).toEqual(['name']);
          return {
            where: (...args: unknown[]) => {
              mergeLogWhere(...args);
              return {
                orderBy: () => ({
                  limit: async () => {
                    if (opts.mergeLogThrows) throw new Error('db down');
                    return opts.mergeLog ?? [];
                  },
                }),
              };
            },
          };
        }
        return { where: () => ({ limit: async () => [row] }) };
      },
    }),
  } as unknown as Database;
  const workspace = {
    ensureRemotesFetched: async () => undefined,
    findAnyWorkspaceId: async () => 'ws',
  } as unknown as WorkspaceService;
  const appliedChangeShas = vi.fn(async () => {
    if (opts.mismatch) {
      throw new AppliedChangeMismatchError(`commit ${MERGE_SHA} is not change request #4's merge`);
    }
    return { baseSha: BASE_SHA, headSha: HEAD_SHA };
  });
  const git = {
    appliedChangeShas,
    changedFilesOfAppliedChange: async () => [
      {
        path: 'Knowledge/A.md',
        status: 'modified' as const,
        additions: 2,
        deletions: 1,
        patch: '@@ -1 +1 @@',
        isBinary: false,
        sha: '',
        rawUrl: '',
      },
    ],
    resolvePrShas: async () => ({ baseSha: BASE_SHA, headSha: HEAD_SHA }),
    changedFilesForPr: async () => [],
    forkPointForPr: async () => ({ mergeBaseSha: BASE_SHA, behind: false }),
    pathsChangedBetween: async () => [],
  } as unknown as GitService;
  const access = { canWriteAtRef: async () => false } as unknown as IAccessControl;
  const svc = new PullRequestService(db, workspace, access, git);
  return { svc, mergeLogWhere, appliedChangeShas };
}

describe('PullRequestService.getPrDetail — how a finished request ended', () => {
  it('an applied request names its applier, when, and its own verified merge commit', async () => {
    const { svc } = harness({}, { mergeLog: [{ name: 'Robin Lee' }] });
    const detail = await svc.getPrDetail(4);
    expect(detail?.finished).toEqual({
      at: CLOSED_AT.toISOString(),
      appliedBy: { name: 'Robin Lee' },
      closedReason: null,
      appliedSha: MERGE_SHA,
    });
    // The summary line counts the change as applied: the merge commit's files.
    expect(detail?.files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ['Knowledge/A.md', 2, 1],
    ]);
  });

  it('an applied request with no succeeded merge-log row names nobody', async () => {
    const { svc } = harness({}, { mergeLog: [] });
    expect((await svc.getPrDetail(4))?.finished).toMatchObject({
      appliedBy: null,
      at: CLOSED_AT.toISOString(),
    });
  });

  it('a failed merge-log read reads as no applier, never as no answer', async () => {
    const { svc } = harness({}, { mergeLogThrows: true });
    expect((await svc.getPrDetail(4))?.finished).toMatchObject({ appliedBy: null, appliedSha: MERGE_SHA });
  });

  it('never sends the recorded sha when it is not the request\'s own merge commit', async () => {
    // The apply made no commit: `merged_sha` is the target tip, usually
    // another request's merge. The verified path refuses it, and so does the
    // finished view's sha.
    const { svc } = harness({}, { mergeLog: [{ name: 'Robin Lee' }], mismatch: true });
    const detail = await svc.getPrDetail(4);
    expect(detail?.finished).toMatchObject({ appliedSha: null, appliedBy: { name: 'Robin Lee' } });
    expect(detail?.files).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain(MERGE_SHA);
  });

  it('a merged row recording no merge commit sends no sha', async () => {
    const { svc, appliedChangeShas } = harness({ mergedSha: null }, { mergeLog: [{ name: 'Robin Lee' }] });
    expect((await svc.getPrDetail(4))?.finished).toMatchObject({ appliedSha: null });
    expect(appliedChangeShas).not.toHaveBeenCalled();
  });

  it('a closed request says when, names nobody, and reads no merge log', async () => {
    const { svc, mergeLogWhere } = harness({ state: 'closed', mergedSha: null });
    expect((await svc.getPrDetail(4))?.finished).toEqual({
      at: CLOSED_AT.toISOString(),
      appliedBy: null,
      closedReason: null,
      appliedSha: null,
    });
    expect(mergeLogWhere).not.toHaveBeenCalled();
  });

  it('a request closed because the knowledge base moved carries that reason', async () => {
    const { svc } = harness({ state: 'closed', mergedSha: null, closedReason: 'repository-replaced' });
    expect((await svc.getPrDetail(4))?.finished).toMatchObject({ closedReason: 'repository-replaced' });
  });

  it('an unknown close reason is not passed through', async () => {
    const { svc } = harness({ state: 'closed', mergedSha: null, closedReason: 'something-else' });
    expect((await svc.getPrDetail(4))?.finished).toMatchObject({ closedReason: null });
  });

  it('an open request carries no finished facts', async () => {
    const { svc, mergeLogWhere } = harness({ state: 'open', mergedSha: null, closedAt: null });
    expect((await svc.getPrDetail(4))?.finished ?? null).toBeNull();
    expect(mergeLogWhere).not.toHaveBeenCalled();
  });

  it('no email address anywhere in a finished answer, even when the recorded name is one', async () => {
    const { svc } = harness({}, { mergeLog: [{ name: 'robin@bevel.software' }] });
    const detail = await svc.getPrDetail(4);
    expect(detail?.finished?.appliedBy).toBeNull();
    const json = JSON.stringify(detail);
    expect(json).not.toContain('robin@bevel.software');
    expect(json).not.toContain('juan@bevel.software');
  });

  it('a cached OPEN detail never answers for the same request once it is applied', async () => {
    // The merge commit's parents are the two tips the open detail was read
    // at, so only the state tells the two answers apart.
    const row: Record<string, unknown> = {};
    const h = harness(row, { mergeLog: [{ name: 'Robin Lee' }] });
    const svc = h.svc as unknown as { detailCache: Map<string, unknown> };
    svc.detailCache.set('ws:anon:4', {
      at: Date.now(),
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      value: { state: 'open', number: 4 },
    });
    const detail = await h.svc.getPrDetail(4);
    expect(detail?.state).toBe('merged');
    expect(detail?.finished?.appliedBy).toEqual({ name: 'Robin Lee' });
  });
});

describe('applierName', () => {
  it('keeps a display name, trimmed', () => {
    expect(applierName('  Robin Lee ')).toEqual({ name: 'Robin Lee' });
  });
  it('drops a blank or missing name', () => {
    expect(applierName('')).toBeNull();
    expect(applierName('   ')).toBeNull();
    expect(applierName(null)).toBeNull();
    expect(applierName(undefined)).toBeNull();
  });
  it('drops anything shaped like an email address', () => {
    expect(applierName('robin@bevel.software')).toBeNull();
    expect(applierName('Robin <robin@bevel.software>')).toBeNull();
  });
});
