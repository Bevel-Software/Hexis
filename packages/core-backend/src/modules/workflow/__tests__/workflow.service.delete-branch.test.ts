import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { AuthUser, DeleteBranchPreview, DeleteBranchResult } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';
import { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import type { Database } from '../../database/connection.js';
import { WorkflowHooks } from '../workflow-hooks.js';
import { WorkflowService } from '../workflow.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import {
  BranchAuthorshipError,
  BranchDeleteBlockedError,
  BranchNotFoundError,
  ProtectedBranchError,
} from '../../../shared/domain-errors.js';

/**
 * An agent's `delete_branch` (`deleteBranchChecked`) and the server's cleanup
 * of branches merged change requests left behind
 * (`retireLeftoverMergedBranches`).
 *
 * The change-request rows are answered by the REAL drizzle query, read back off
 * the SQL the pg-proxy driver hands over (the harness of
 * `workflow.service.branch-in-use.test.ts`): a stub answering by call order
 * would pass just as happily against a guard that asked about the wrong end of
 * a request, or the wrong state.
 */

interface CrRow {
  number: number;
  source_branch: string;
  target_branch: string;
  state: string;
  merged_sha: string | null;
}

/** The guarded closes the fake table applied, as `{ number, params }`. */
const closes: { number: number; params: unknown[] }[] = [];

function fakeDb(rows: CrRow[]): Database {
  return drizzle(async (sql: string, params: unknown[]) => {
    if (/^\s*update/i.test(sql)) {
      // The guarded close: `update … set state, closed_at … where number = $n and state = 'open'`.
      const at = /"number"\s*=\s*\$(\d+)/.exec(sql);
      const number = at ? params[Number(at[1]) - 1] : undefined;
      const row = rows.find((r) => r.number === number && r.state === 'open');
      if (!row || !/"closed_at"/.test(sql)) return { rows: [] };
      row.state = 'closed';
      closes.push({ number: row.number, params });
      return { rows: [['row-id']] };
    }
    if (!/^\s*select/i.test(sql)) return { rows: [['row-id']] };
    const projection = (/^\s*select\s+(.+?)\s+from\s/is.exec(sql)?.[1] ?? '')
      .split(',')
      .map((item) => item.trim().replace(/.*"(\w+)"$/, '$1'));
    const byValue = new Map<unknown, string[]>();
    for (const m of sql.matchAll(/"(\w+)"\s*=\s*\$(\d+)/g)) {
      const value = params[Number(m[2]) - 1];
      byValue.set(value, [...(byValue.get(value) ?? []), m[1]!]);
    }
    if (!projection.length || projection.some((c) => !/^\w+$/.test(c))) {
      throw new Error(`fakeDb could not read the projection of: ${sql}`);
    }
    if (/\bwhere\b/i.test(sql) && byValue.size === 0) {
      throw new Error(`fakeDb could not read the predicate of: ${sql}`);
    }
    const matched = rows.filter((row) =>
      [...byValue].every(([value, columns]) => columns.some((c) => row[c as keyof CrRow] === value)),
    );
    return { rows: matched.map((row) => projection.map((c) => row[c as keyof CrRow])) };
  }) as unknown as Database;
}

const ADMIN: AuthUser = { id: 'u-ana', email: 'ana@example.com', name: 'Ana' };
const BOB: AuthUser = { id: 'u-bob', email: 'bob@example.com', name: 'Bob' };
const DEFAULT = 'target-company-state';

type State = { exists: boolean; lastCommit: string | null; unmergedCommits: number };

interface Harness {
  svc: WorkflowService;
  git: {
    branchState: ReturnType<typeof vi.fn>;
    mayDeleteBranch: ReturnType<typeof vi.fn>;
    isAncestor: ReturnType<typeof vi.fn>;
    changedPathsForPr: ReturnType<typeof vi.fn>;
    deleteBranch: ReturnType<typeof vi.fn>;
  };
  fetch: ReturnType<typeof vi.fn>;
  deleted: string[];
  fileLocks: FileLockService;
  hasAnyActive: MockInstance<FileLockService['hasAnyActive']>;
}

/**
 * A service over a mocked git layer. `branches` is the shared repository as
 * the fetch left it; `ancestry` lists the `[tip, mergeCommit]` pairs that are
 * contained; `admins` may delete anything; `savesLanding` names the branches
 * whose checkout still has a save or a lock.
 */
function harness(opts: {
  rows?: CrRow[];
  branches?: Record<string, State>;
  ancestry?: [string, string][];
  admins?: string[];
  savesLanding?: string[];
  /** Branches whose checkout has a commit queued (no lock held). */
  commitsQueued?: string[];
  fetchFails?: boolean;
  /** The changes each open request proposes, by its source branch; absent, one file. `error`: undeterminable. */
  changes?: Record<string, string[] | 'error'>;
}): Harness {
  const deleted: string[] = [];
  const rows = opts.rows ?? [];
  const branches = { ...(opts.branches ?? {}) };
  const git = {
    branchState: vi.fn(async (_ws: string, name: string): Promise<State> =>
      branches[name] ?? { exists: false, lastCommit: null, unmergedCommits: 0 },
    ),
    mayDeleteBranch: vi.fn(async (_ws: string, name: string, user: AuthUser) =>
      (opts.admins ?? [ADMIN.email]).includes(user.email) || name.startsWith(`${user.email.split('@')[0]}/`),
    ),
    isAncestor: vi.fn(async (_ws: string, a: string, d: string) =>
      (opts.ancestry ?? []).some(([x, y]) => x === a && y === d),
    ),
    changedPathsForPr: vi.fn(async (_ws: string, _base: string, head: string) => {
      const c = opts.changes?.[head] ?? ['KnowledgeBase/f.md'];
      if (c === 'error') throw new Error('unknown branch');
      return c;
    }),
    deleteBranch: vi.fn(async (_ws: string, name: string) => {
      deleted.push(name);
      const tip = branches[name]?.lastCommit ?? null;
      delete branches[name];
      return { lastCommit: tip };
    }),
  };
  const fetch = vi.fn(async () => {
    if (opts.fetchFails) throw new Error('git fetch origin failed — remote refs could not be refreshed');
  });
  const landing = new Set((opts.savesLanding ?? []).map(workspaceIdForBranch));
  const queued = new Set((opts.commitsQueued ?? []).map(workspaceIdForBranch));
  // The real service, for its gate on acquiring; what is held is mocked.
  const fileLocks = new FileLockService({} as Database);
  const hasAnyActive = vi.spyOn(fileLocks, 'hasAnyActive').mockImplementation(async (ws: string) => landing.has(ws));
  const svc = new WorkflowService(
    fakeDb(rows),
    git as unknown as GitService,
    {
      invalidateDetailCache: vi.fn(),
      getPr: vi.fn(async (n: number) => {
        const row = rows.find((r) => r.number === n);
        return row
          ? { number: n, branch: row.source_branch, base: row.target_branch, state: row.state, url: `https://hexis.test/change-requests/${n}` }
          : null;
      }),
    } as unknown as PullRequestService,
    {} as IReviewWorkflowService,
    {
      getOrCreateForBranch: vi.fn(async (b: string) => ({ id: workspaceIdForBranch(b) })),
      ensureRemotesFetched: fetch,
      hasBootstrappedWorkspace: vi.fn(async () => false),
    } as unknown as WorkspaceService,
    {} as IAccessControl,
    fileLocks,
    { hasAnyForWorkspace: vi.fn(async (ws: string) => queued.has(ws)) } as unknown as PendingCommitsService,
    testKbContext(),
    openChangeGate(),
  );
  return { svc, git, fetch, deleted, fileLocks, hasAnyActive };
}

const merged = (number: number, source: string, sha: string | null): CrRow => ({
  number,
  source_branch: source,
  target_branch: DEFAULT,
  state: 'merged',
  merged_sha: sha,
});
const open = (number: number, source: string, target: string): CrRow => ({
  number,
  source_branch: source,
  target_branch: target,
  state: 'open',
  merged_sha: null,
});
const clean = (sha: string): State => ({ exists: true, lastCommit: sha, unmergedCommits: 0 });

async function refusal(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof Error)) throw new Error('expected a refusal, got a success');
  return err;
}

describe('deleteBranchChecked — an agent deletes a branch', () => {
  it("deletes a colleague's merged draft for an Admin, from the default branch's workspace, and answers its last commit", async () => {
    const h = harness({ branches: { 'ali/old-draft': clean('a1') } });
    const result = (await h.svc.deleteBranchChecked(ADMIN, 'ali/old-draft')) as DeleteBranchResult;
    expect(result).toEqual({ kind: 'deleted', branch: 'ali/old-draft', lastCommit: 'a1', discardedCommits: 0 });
    // Fetched strictly and freshly first, and acted from the default branch's
    // workspace — never the caller's, never the branch's own.
    expect(h.fetch).toHaveBeenCalledWith(workspaceIdForBranch(DEFAULT), { strict: true, force: true });
    expect(h.git.deleteBranch).toHaveBeenCalledWith(workspaceIdForBranch(DEFAULT), 'ali/old-draft', ADMIN, {
      expectTip: 'a1',
    });
  });

  it('refuses anyone who is neither the author nor an Admin, with the existing message, and deletes nothing', async () => {
    const h = harness({ branches: { 'ali/old-draft': clean('a1') } });
    const err = await refusal(h.svc.deleteBranchChecked(BOB, 'ali/old-draft'));
    expect(err).toBeInstanceOf(BranchAuthorshipError);
    expect(err.message).toBe('Only the author of "ali/old-draft" can delete it.');
    expect(h.deleted).toEqual([]);
  });

  it("lets the author delete their own draft", async () => {
    const h = harness({ branches: { 'bob/draft': clean('b1') } });
    await expect(h.svc.deleteBranchChecked(BOB, 'bob/draft')).resolves.toMatchObject({ kind: 'deleted' });
    expect(h.deleted).toEqual(['bob/draft']);
  });

  it('refuses a protected branch', async () => {
    const h = harness({ branches: { [DEFAULT]: clean('m1'), 'current-company-state': clean('c1') } });
    await expect(h.svc.deleteBranchChecked(ADMIN, DEFAULT)).rejects.toBeInstanceOf(ProtectedBranchError);
    await expect(h.svc.deleteBranchChecked(ADMIN, 'current-company-state')).rejects.toBeInstanceOf(
      ProtectedBranchError,
    );
    expect(h.deleted).toEqual([]);
  });

  it('refuses while a change request is open FROM the branch, naming it and sending the user to the app', async () => {
    const h = harness({ rows: [open(12, 'ali/draft', DEFAULT)], branches: { 'ali/draft': clean('a1') } });
    const err = await refusal(h.svc.deleteBranchChecked(ADMIN, 'ali/draft'));
    expect(err).toBeInstanceOf(BranchDeleteBlockedError);
    expect((err as BranchDeleteBlockedError).status).toBe(409);
    expect((err as BranchDeleteBlockedError).payload).toMatchObject({ reason: 'open-change-request', number: 12 });
    expect(err.message).toContain('#12');
    // It links to the request and says who can act on it.
    expect(err.message).toContain('https://hexis.test/change-requests/12');
    expect(err.message).toContain('Its author can withdraw it, or an Admin can decline it, in the app');
    expect((err as BranchDeleteBlockedError).payload).toMatchObject({ url: 'https://hexis.test/change-requests/12' });
    expect(h.deleted).toEqual([]);
  });

  it('refuses while a change request is open INTO the branch', async () => {
    const h = harness({ rows: [open(13, 'ali/other', 'ali/draft')], branches: { 'ali/draft': clean('a1') } });
    const err = await refusal(h.svc.deleteBranchChecked(ADMIN, 'ali/draft'));
    expect(err.message).toContain('#13');
    expect(err.message).toContain('open into "ali/draft"');
    expect(h.deleted).toEqual([]);
  });

  it('refuses a branch holding commits not on the default branch, saying how many', async () => {
    const h = harness({ branches: { 'ali/draft': { exists: true, lastCommit: 'a3', unmergedCommits: 3 } } });
    const err = await refusal(h.svc.deleteBranchChecked(ADMIN, 'ali/draft'));
    expect(err).toBeInstanceOf(BranchDeleteBlockedError);
    expect((err as BranchDeleteBlockedError).payload).toMatchObject({ reason: 'unmerged-commits', unmergedCommits: 3 });
    expect(err.message).toContain('3 commits');
    expect(err.message).toContain('discardUnmerged');
    expect(h.deleted).toEqual([]);
  });

  it('with discardUnmerged, deletes it anyway and reports the discarded commits', async () => {
    const h = harness({ branches: { 'ali/draft': { exists: true, lastCommit: 'a3', unmergedCommits: 3 } } });
    await expect(h.svc.deleteBranchChecked(ADMIN, 'ali/draft', { discardUnmerged: true })).resolves.toEqual({
      kind: 'deleted',
      branch: 'ali/draft',
      lastCommit: 'a3',
      discardedCommits: 3,
    });
  });

  it('refuses a branch with saves still landing, with or without discardUnmerged', async () => {
    const h = harness({
      branches: { 'ali/draft': { exists: true, lastCommit: 'a3', unmergedCommits: 3 } },
      savesLanding: ['ali/draft'],
    });
    for (const discardUnmerged of [false, true]) {
      const err = await refusal(h.svc.deleteBranchChecked(ADMIN, 'ali/draft', { discardUnmerged }));
      expect((err as BranchDeleteBlockedError).payload).toMatchObject({ reason: 'saves-landing' });
      expect(err.message).toContain('Try again once they have landed');
    }
    expect(h.deleted).toEqual([]);
  });

  it('refuses a branch with a commit still queued and no file held, with or without discardUnmerged', async () => {
    const h = harness({
      branches: { 'ali/draft': { exists: true, lastCommit: 'a3', unmergedCommits: 3 } },
      commitsQueued: ['ali/draft'],
    });
    for (const discardUnmerged of [false, true]) {
      const err = await refusal(h.svc.deleteBranchChecked(ADMIN, 'ali/draft', { discardUnmerged }));
      expect((err as BranchDeleteBlockedError).payload).toMatchObject({ reason: 'saves-landing' });
    }
    expect(h.deleted).toEqual([]);
  });

  it('refuses a save whose lock was taken after the first check, and grants no lock while it deletes', async () => {
    const h = harness({ branches: { 'ali/draft': clean('a1') } });
    // Nothing held at the first check; a save takes its lock before the delete.
    h.hasAnyActive.mockResolvedValueOnce(false).mockResolvedValue(true);
    const err = await refusal(h.svc.deleteBranchChecked(ADMIN, 'ali/draft'));
    expect((err as BranchDeleteBlockedError).payload).toMatchObject({ reason: 'saves-landing' });
    expect(h.deleted).toEqual([]);

    // Once the checks pass, no save can start until the branch is gone.
    h.hasAnyActive.mockResolvedValue(false);
    let during: unknown = null;
    h.git.deleteBranch.mockImplementationOnce(async () => {
      during = await h.fileLocks.acquire(workspaceIdForBranch('ali/draft'), 'ali/draft', 'KnowledgeBase/f.md', BOB).catch((e: unknown) => e);
      return { lastCommit: 'a1' };
    });
    await h.svc.deleteBranchChecked(ADMIN, 'ali/draft');
    expect(during).toBeInstanceOf(Error);
    expect((during as { payload?: unknown }).payload).toMatchObject({ kind: 'branch-being-deleted' });
  });

  it('answers "no branch named …" for a name that is not a branch, never a success', async () => {
    const h = harness({});
    const err = await refusal(h.svc.deleteBranchChecked(ADMIN, 'ali/no-such-branch'));
    expect(err).toBeInstanceOf(BranchNotFoundError);
    expect((err as BranchNotFoundError).status).toBe(404);
    expect(err.message).toContain('no branch named ali/no-such-branch');
    expect(h.git.deleteBranch).not.toHaveBeenCalled();
  });

  it('refuses, and deletes nothing, when the shared repository cannot be reached', async () => {
    const h = harness({ branches: { 'ali/draft': clean('a1') }, fetchFails: true });
    const err = await refusal(h.svc.deleteBranchChecked(ADMIN, 'ali/draft'));
    expect(err).toBeInstanceOf(BranchDeleteBlockedError);
    expect((err as BranchDeleteBlockedError).status).toBe(503);
    expect(err.message).toContain('nothing was deleted');
    expect(h.git.branchState).not.toHaveBeenCalled();
    expect(h.deleted).toEqual([]);
  });

  it('dryRun changes nothing and reports existence, permission and why not, unmerged commits, open requests and the last commit', async () => {
    const h = harness({
      rows: [open(12, 'ali/draft', DEFAULT), open(14, 'ali/other', 'ali/draft')],
      branches: { 'ali/draft': { exists: true, lastCommit: 'a2', unmergedCommits: 2 } },
    });
    const preview = (await h.svc.deleteBranchChecked(BOB, 'ali/draft', { dryRun: true })) as DeleteBranchPreview;
    expect(preview).toMatchObject({
      kind: 'preview',
      branch: 'ali/draft',
      exists: true,
      canDelete: false,
      unmergedCommits: 2,
      openChangeRequests: [
        { number: 12, end: 'source', url: 'https://hexis.test/change-requests/12', proposesNothing: false },
        { number: 14, end: 'target', url: 'https://hexis.test/change-requests/14', proposesNothing: false },
      ],
      lastCommit: 'a2',
    });
    expect(preview.refusals).toHaveLength(3);
    expect(preview.refusals[0]).toBe('Only the author of "ali/draft" can delete it.');
    expect(preview.refusals.join(' ')).toContain('#12');
    expect(preview.refusals.join(' ')).toContain('2 commits');
    expect(h.git.deleteBranch).not.toHaveBeenCalled();
  });

  it('dryRun of a deletable branch says it can be deleted; of a missing one, that it does not exist', async () => {
    const h = harness({ branches: { 'ali/draft': clean('a1') } });
    await expect(h.svc.deleteBranchChecked(ADMIN, 'ali/draft', { dryRun: true })).resolves.toEqual({
      kind: 'preview',
      branch: 'ali/draft',
      exists: true,
      canDelete: true,
      refusals: [],
      unmergedCommits: 0,
      openChangeRequests: [],
      lastCommit: 'a1',
    });
    const missing = (await h.svc.deleteBranchChecked(ADMIN, 'ali/gone', { dryRun: true })) as DeleteBranchPreview;
    expect(missing).toMatchObject({ exists: false, canDelete: false, lastCommit: null });
    expect(missing.refusals[0]).toContain('no branch named ali/gone');
    expect(h.deleted).toEqual([]);
  });

  it('a preview grants nothing: a commit pushed after it is refused at deletion', async () => {
    const branches: Record<string, State> = { 'ali/draft': clean('a1') };
    const h = harness({ branches });
    const preview = (await h.svc.deleteBranchChecked(ADMIN, 'ali/draft', { dryRun: true })) as DeleteBranchPreview;
    expect(preview.canDelete).toBe(true);
    // A colleague pushes before the delete.
    branches['ali/draft'] = { exists: true, lastCommit: 'a2', unmergedCommits: 1 };
    h.git.branchState.mockImplementation(async (_ws: string, name: string) => branches[name]);
    const err = await refusal(h.svc.deleteBranchChecked(ADMIN, 'ali/draft'));
    expect((err as BranchDeleteBlockedError).payload).toMatchObject({ reason: 'unmerged-commits', unmergedCommits: 1 });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.deleted).toEqual([]);
  });
});

describe('a change request that proposes nothing never blocks a deletion', () => {
  beforeEach(() => {
    closes.length = 0;
  });

  it('closes an empty request FROM the branch and one INTO it, then deletes — without waiting on its own lock', async () => {
    const rows = [open(21, 'ali/sync', DEFAULT), open(22, 'ali/feature', 'ali/sync')];
    const h = harness({ rows, branches: { 'ali/sync': clean('s1') }, changes: { 'ali/sync': [], 'ali/feature': [] } });
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    try {
      // The request's source IS the branch being deleted: a self-wait would hang here.
      await expect(h.svc.deleteBranchChecked(ADMIN, 'ali/sync')).resolves.toMatchObject({ kind: 'deleted', lastCommit: 's1' });
    } finally {
      spy.mockRestore();
    }
    expect(rows.map((r) => r.state)).toEqual(['closed', 'closed']);
    expect(h.deleted).toEqual(['ali/sync']);
    // Recorded as today's empty-close: closed, with a closing time.
    expect(closes.map((c) => c.number)).toEqual([21, 22]);
    const isTime = (v: unknown) => v instanceof Date || (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v));
    for (const c of closes) expect(c.params.some(isTime), String(c.params)).toBe(true);
    // One log line per close, naming the request, its branches and why.
    const closeLines = lines.filter((l) => l.includes('closed change request #'));
    expect(closeLines).toEqual([
      '[cr] closed change request #21 ("ali/sync" into "target-company-state") by ana@example.com: it proposes nothing (empty when "ali/sync" was deleted)',
      '[cr] closed change request #22 ("ali/feature" into "ali/sync") by ana@example.com: it proposes nothing (empty when "ali/sync" was deleted)',
    ]);
  });

  it('a request that still proposes something refuses, with the link, and closes nothing — not even the empty one beside it', async () => {
    const rows = [open(21, 'ali/sync', DEFAULT), open(23, 'ali/other', 'ali/sync')];
    const h = harness({ rows, branches: { 'ali/sync': clean('s1') }, changes: { 'ali/sync': [] } });
    const err = await refusal(h.svc.deleteBranchChecked(ADMIN, 'ali/sync'));
    expect((err as BranchDeleteBlockedError).payload).toMatchObject({ reason: 'open-change-request', number: 23 });
    expect(err.message).toContain('https://hexis.test/change-requests/23');
    expect(err.message).toContain('Its author can withdraw it, or an Admin can decline it');
    expect(rows.map((r) => r.state)).toEqual(['open', 'open']);
    expect(h.deleted).toEqual([]);
  });

  it('a request whose changes cannot be determined counts as proposing something', async () => {
    const rows = [open(21, 'ali/sync', DEFAULT)];
    const h = harness({ rows, branches: { 'ali/sync': clean('s1') }, changes: { 'ali/sync': 'error' } });
    const err = await refusal(h.svc.deleteBranchChecked(ADMIN, 'ali/sync'));
    expect((err as BranchDeleteBlockedError).payload).toMatchObject({ reason: 'open-change-request', number: 21 });
    expect(rows[0]!.state).toBe('open');
    expect(h.deleted).toEqual([]);
  });

  it('a request with a save still landing on its branch counts as proposing something', async () => {
    // The request comes INTO the branch being deleted; the save lands on its source.
    const rows = [open(22, 'ali/feature', 'ali/sync')];
    const h = harness({
      rows,
      branches: { 'ali/sync': clean('s1') },
      changes: { 'ali/feature': [] },
      savesLanding: ['ali/feature'],
    });
    const err = await refusal(h.svc.deleteBranchChecked(ADMIN, 'ali/sync'));
    expect((err as BranchDeleteBlockedError).payload).toMatchObject({ reason: 'open-change-request', number: 22 });
    expect(rows[0]!.state).toBe('open');
    expect(h.deleted).toEqual([]);
  });

  it('a deletion refused for another reason closes nothing', async () => {
    const rows = [open(21, 'ali/sync', DEFAULT)];
    const h = harness({ rows, branches: { 'ali/sync': clean('s1') }, changes: { 'ali/sync': [] } });
    await expect(h.svc.deleteBranchChecked(BOB, 'ali/sync')).rejects.toBeInstanceOf(BranchAuthorshipError);
    expect(rows[0]!.state).toBe('open');
  });

  it('the preview reports an empty request as one the delete would close, and closes nothing', async () => {
    const rows = [open(21, 'ali/sync', DEFAULT)];
    const h = harness({ rows, branches: { 'ali/sync': clean('s1') }, changes: { 'ali/sync': [] } });
    await expect(h.svc.deleteBranchChecked(ADMIN, 'ali/sync', { dryRun: true })).resolves.toMatchObject({
      canDelete: true,
      refusals: [],
      openChangeRequests: [{ number: 21, end: 'source', url: 'https://hexis.test/change-requests/21', proposesNothing: true }],
    });
    expect(rows[0]!.state).toBe('open');
    expect(h.deleted).toEqual([]);
  });

  it("the app's delete closes an empty request too, and goes ahead", async () => {
    const rows = [open(21, 'ana/sync', DEFAULT)];
    const h = harness({ rows, branches: { 'ana/sync': clean('s1') }, changes: { 'ana/sync': [] } });
    await h.svc.deleteBranch(workspaceIdForBranch(DEFAULT), 'ana/sync', ADMIN);
    expect(rows[0]!.state).toBe('closed');
    expect(h.deleted).toEqual(['ana/sync']);
    // No fetch-first in the app's path.
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("the app's delete still refuses on a request that proposes something, and closes nothing for a non-author", async () => {
    const rows = [open(21, 'ali/sync', DEFAULT), open(24, 'ana/live', DEFAULT)];
    const h = harness({ rows, branches: { 'ali/sync': clean('s1'), 'ana/live': clean('l1') }, changes: { 'ali/sync': [] } });
    await expect(h.svc.deleteBranch(workspaceIdForBranch(DEFAULT), 'ana/live', ADMIN)).rejects.toThrow(/open change request \(#24\)/);
    await expect(h.svc.deleteBranch(workspaceIdForBranch(DEFAULT), 'ali/sync', BOB)).rejects.toThrow(/open change request \(#21\)/);
    expect(rows.map((r) => r.state)).toEqual(['open', 'open']);
    expect(h.deleted).toEqual([]);
  });
});

describe('closeEmptyOpenChangeRequests — the background close', () => {
  it('closes the open requests that propose nothing and removes their source branch; leaves the rest open', async () => {
    const rows = [
      open(31, 'ali/empty', DEFAULT),
      open(32, 'ali/live', DEFAULT),
      open(33, 'ali/unknown', DEFAULT),
      open(34, 'ali/saving', DEFAULT),
    ];
    const h = harness({
      rows,
      admins: [],
      branches: { 'ali/empty': clean('e1'), 'ali/live': clean('l1') },
      changes: { 'ali/empty': [], 'ali/unknown': 'error', 'ali/saving': [] },
      savesLanding: ['ali/saving'],
    });
    await expect(h.svc.closeEmptyOpenChangeRequests()).resolves.toBe(1);
    expect(rows.map((r) => r.state)).toEqual(['closed', 'open', 'open', 'open']);
    // Judged from the default branch's workspace after one fetch, not by cloning each request's branch.
    expect(h.fetch).toHaveBeenCalledTimes(2); // the round's fetch, then the retirement's own
    expect(h.git.changedPathsForPr).toHaveBeenCalledWith(workspaceIdForBranch(DEFAULT), DEFAULT, 'ali/empty', { fetch: false });
    // The source branch is removed as opening the page would, by `system`.
    expect(h.deleted).toEqual(['ali/empty']);
    expect(h.git.deleteBranch).toHaveBeenCalledWith(
      workspaceIdForBranch(DEFAULT),
      'ali/empty',
      expect.objectContaining({ email: 'system' }),
      { systemCleanup: true },
    );
  });

  it('closes nothing in a round whose fetch fails', async () => {
    const rows = [open(31, 'ali/empty', DEFAULT)];
    const h = harness({ rows, branches: { 'ali/empty': clean('e1') }, changes: { 'ali/empty': [] }, fetchFails: true });
    await expect(h.svc.closeEmptyOpenChangeRequests()).resolves.toBe(0);
    expect(rows[0]!.state).toBe('open');
    expect(h.deleted).toEqual([]);
  });

  it('does nothing once the graph has stopped it, and drains what was running', async () => {
    const rows = [open(31, 'ali/empty', DEFAULT), merged(32, 'ali/done', 'm1')];
    const h = harness({
      rows,
      branches: { 'ali/empty': clean('e1'), 'ali/done': clean('d1') },
      ancestry: [['d1', 'm1']],
      changes: { 'ali/empty': [] },
    });
    h.svc.stopTidying();
    await expect(h.svc.tidyAfterSweep()).resolves.toEqual({ closedEmpty: 0, removedLeftovers: 0 });
    await h.svc.drainTidy();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(rows[0]!.state).toBe('open');
    expect(h.deleted).toEqual([]);
  });

  it('runs before the leftover cleanup, and even with that cleanup switched off', async () => {
    const h = harness({});
    const order: string[] = [];
    vi.spyOn(h.svc, 'closeEmptyOpenChangeRequests').mockImplementation(async () => (order.push('empty'), 2));
    h.svc.leftoverCleanupEnabled = () => false;
    const leftover = vi.spyOn(h.svc, 'retireLeftoverMergedBranches');
    leftover.mockImplementation(async () => (order.push('leftover'), 0));
    await expect(h.svc.tidyAfterSweep()).resolves.toEqual({ closedEmpty: 2, removedLeftovers: 0 });
    expect(order).toEqual(['empty', 'leftover']);
  });
});

describe('retireLeftoverMergedBranches — the server removes what merged change requests left behind', () => {
  it('removes only the qualifying branches, as `system`', async () => {
    const h = harness({
      rows: [
        merged(3, 'ali/sync-0709', 'm3'), // qualifies
        merged(4, 'ali/sync-0901', 'm4'), // new commits since the merge
        merged(5, 'ali/recreated', 'm5'), // recreated after the merge: tip not in m5
        merged(6, 'ali/no-merge-sha', null), // no recorded merge commit
        merged(7, 'ali/target-of-open', 'm7'), // an open request goes into it
        open(8, 'ali/feeds', 'ali/target-of-open'),
        merged(9, 'ali/saving', 'm9'), // a save is still landing
        merged(10, 'current-company-state', 'm10'), // protected
        merged(11, 'ali/already-gone', 'm11'), // not there any more
      ],
      branches: {
        'ali/sync-0709': clean('t3'),
        'ali/sync-0901': { exists: true, lastCommit: 't4b', unmergedCommits: 2 },
        'ali/recreated': clean('fresh'),
        'ali/no-merge-sha': clean('t6'),
        'ali/target-of-open': clean('t7'),
        'ali/saving': clean('t9'),
        'current-company-state': clean('t10'),
        'ali/sync-0806': { exists: true, lastCommit: 'x', unmergedCommits: 4 }, // never had a request
        'ali/brand-new': clean('base'), // a minute old, no request
      },
      ancestry: [
        ['t3', 'm3'],
        ['t4', 'm4'],
        ['t6', 'm6'],
        ['t7', 'm7'],
        ['t9', 'm9'],
        ['t10', 'm10'],
      ],
      savesLanding: ['ali/saving'],
    });
    await expect(h.svc.retireLeftoverMergedBranches()).resolves.toBe(1);
    expect(h.deleted).toEqual(['ali/sync-0709']);
    expect(h.git.deleteBranch).toHaveBeenCalledWith(
      workspaceIdForBranch(DEFAULT),
      'ali/sync-0709',
      expect.objectContaining({ email: 'system' }),
      { systemCleanup: true, expectTip: 't3' },
    );
  });

  it('writes one log line per deletion, naming who did it (or system), the branch and its last commit', async () => {
    const h = harness({
      rows: [merged(3, 'ali/sync-0709', 'm3')],
      branches: { 'ali/sync-0709': clean('t3'), 'ali/old-draft': clean('a1'), 'ana/mine': clean('n1') },
      ancestry: [['t3', 'm3']],
    });
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    try {
      await h.svc.retireLeftoverMergedBranches();
      await h.svc.deleteBranchChecked(ADMIN, 'ali/old-draft');
      // The app's branch switcher: today's path, gaining only the line.
      await h.svc.deleteBranch(workspaceIdForBranch(DEFAULT), 'ana/mine', ADMIN);
    } finally {
      spy.mockRestore();
    }
    const deletions = lines.filter((l) => l.includes('branch deleted by'));
    expect(deletions).toEqual([
      '[workflow] branch deleted by system: "ali/sync-0709" at t3',
      '[workflow] branch deleted by ana@example.com: "ali/old-draft" at a1',
      '[workflow] branch deleted by ana@example.com: "ana/mine" at n1',
    ]);
  });

  it('takes any of several merged requests from the same branch name', async () => {
    const h = harness({
      rows: [merged(3, 'ali/twice', 'm3'), merged(20, 'ali/twice', 'm20')],
      branches: { 'ali/twice': clean('t20') },
      ancestry: [['t20', 'm20']],
    });
    await expect(h.svc.retireLeftoverMergedBranches()).resolves.toBe(1);
    expect(h.deleted).toEqual(['ali/twice']);
  });

  it('removes nothing in a round whose fetch fails', async () => {
    const h = harness({
      rows: [merged(3, 'ali/sync-0709', 'm3')],
      branches: { 'ali/sync-0709': clean('t3') },
      ancestry: [['t3', 'm3']],
      fetchFails: true,
    });
    await expect(h.svc.retireLeftoverMergedBranches()).resolves.toBe(0);
    expect(h.git.branchState).not.toHaveBeenCalled();
    expect(h.deleted).toEqual([]);
  });

  it('removes nothing when switched off, without even fetching', async () => {
    const h = harness({
      rows: [merged(3, 'ali/sync-0709', 'm3')],
      branches: { 'ali/sync-0709': clean('t3') },
      ancestry: [['t3', 'm3']],
    });
    h.svc.leftoverCleanupEnabled = () => false;
    await expect(h.svc.retireLeftoverMergedBranches()).resolves.toBe(0);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.deleted).toEqual([]);
  });

  it('switching it off leaves the removal of a branch when its change request is merged alone', async () => {
    const h = harness({ rows: [merged(3, 'ali/just-merged', 'm3')], branches: { 'ali/just-merged': clean('t3') } });
    h.svc.leftoverCleanupEnabled = () => false;
    const retire = (h.svc as unknown as {
      retireMergedSourceBranch(n: number, base: string, u: AuthUser): Promise<void>;
    }).retireMergedSourceBranch.bind(h.svc);
    await retire(3, DEFAULT, ADMIN);
    expect(h.deleted).toEqual(['ali/just-merged']);
  });

  it('a branch it cannot read is left, and the round goes on', async () => {
    const h = harness({
      rows: [merged(3, 'ali/broken', 'm3'), merged(4, 'ali/fine', 'm4')],
      branches: { 'ali/fine': clean('t4') },
      ancestry: [['t4', 'm4']],
    });
    const real = h.git.branchState.getMockImplementation()!;
    h.git.branchState.mockImplementation(async (ws: string, name: string, d: string) => {
      if (name === 'ali/broken') throw new Error('bad object');
      return real(ws, name, d);
    });
    await expect(h.svc.retireLeftoverMergedBranches()).resolves.toBe(1);
    expect(h.deleted).toEqual(['ali/fine']);
  });

  it('runs after every on-demand sweep for deleted branches', async () => {
    const h = harness({});
    const cleanup = vi.spyOn(h.svc, 'tidyAfterSweep').mockResolvedValue({ closedEmpty: 0, removedLeftovers: 0 });
    vi.spyOn(h.svc, 'closeChangeRequestsWithDeletedBranches').mockResolvedValue(0);
    (h.svc as unknown as { kickDeletedBranchSweep(): void }).kickDeletedBranchSweep();
    await (h.svc as unknown as { sweepKick: Promise<void> }).sweepKick;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

// ── End to end, over real git ────────────────────────────────────────────────

const execFileAsync = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@x.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@x.com',
};
const git = async (cwd: string, args: string[]) =>
  (await execFileAsync('git', args, { cwd, env: GIT_ENV })).stdout.trim();

describe('deleteBranchChecked over real git — a delete made from another workspace', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-delete-branch-checked-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("removes the branch from the shared repository and the server, though the call came from the branch's own workspace", async () => {
    const upstream = path.join(root, 'upstream.git');
    await git(root, ['init', '--bare', '-b', DEFAULT, upstream]);
    const seed = path.join(root, '.seed');
    await git(root, ['clone', upstream, seed]);
    await git(seed, ['checkout', '-b', DEFAULT]);
    await git(seed, ['commit', '--allow-empty', '-m', 'init']);
    await git(seed, ['push', 'origin', DEFAULT]);
    await git(seed, ['checkout', '-b', 'bob/draft']);
    await git(seed, ['push', 'origin', 'bob/draft']);

    // Two clones on the server: the default branch's, and the draft's own,
    // which has the draft checked out (git refuses to delete from there).
    const wsDir = (id: string) => path.join(root, 'workspaces', id);
    const defaultId = workspaceIdForBranch(DEFAULT);
    const draftId = workspaceIdForBranch('bob/draft');
    await git(root, ['clone', '-b', DEFAULT, upstream, path.join(wsDir(defaultId), 'knowledge-base')]);
    await git(root, ['clone', '-b', 'bob/draft', upstream, path.join(wsDir(draftId), 'knowledge-base')]);
    const tip = await git(seed, ['rev-parse', 'HEAD']);

    const workspaces = {
      getWorkspacePath: async (id: string) => wsDir(id),
      getOrCreateForBranch: async (b: string) => ({ id: workspaceIdForBranch(b) }),
      ensureRemotesFetched: async (id: string) => {
        await git(path.join(wsDir(id), 'knowledge-base'), ['fetch', '--prune', 'origin']);
      },
      hasBootstrappedWorkspace: async (id: string) =>
        fs.stat(path.join(wsDir(id), 'knowledge-base', '.git')).then(
          () => true,
          () => false,
        ),
      deleteWorkspace: async (id: string) => fs.rm(wsDir(id), { recursive: true, force: true }),
    } as unknown as WorkspaceService;
    const gitService = new GitService(workspaces, new WorkflowHooks(), testKbContext());
    const svc = new WorkflowService(
      fakeDb([]),
      gitService,
      { invalidateDetailCache: vi.fn() } as unknown as PullRequestService,
      {} as IReviewWorkflowService,
      workspaces,
      {} as IAccessControl,
      { hasAnyActive: async () => false, whileNoneAcquired: (_b: string, fn: () => Promise<unknown>) => fn() } as unknown as FileLockService,
      { hasAnyForWorkspace: async () => false } as unknown as PendingCommitsService,
      testKbContext(),
      openChangeGate(),
    );

    await expect(svc.deleteBranchChecked(BOB, 'bob/draft')).resolves.toEqual({
      kind: 'deleted',
      branch: 'bob/draft',
      lastCommit: tip,
      discardedCommits: 0,
    });
    expect(await git(upstream, ['for-each-ref', 'refs/heads/bob/draft'])).toBe('');
    // The draft's own clone on the server went with it.
    await expect(fs.stat(wsDir(draftId))).rejects.toThrow();
    // Asked again, it is not a branch.
    await expect(svc.deleteBranchChecked(BOB, 'bob/draft')).rejects.toBeInstanceOf(BranchNotFoundError);
  });
});

describe('emptiness over real git — judged from the default workspace as from the branch’s own', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-empty-request-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('answers the same changed paths from either clone, before and after the change lands on the default branch', async () => {
    const upstream = path.join(root, 'upstream.git');
    await git(root, ['init', '--bare', '-b', DEFAULT, upstream]);
    const seed = path.join(root, '.seed');
    await git(root, ['clone', upstream, seed]);
    await git(seed, ['checkout', '-b', DEFAULT]);
    await fs.mkdir(path.join(seed, 'KnowledgeBase'));
    await fs.writeFile(path.join(seed, 'KnowledgeBase', 'f.md'), 'one\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-m', 'init']);
    await git(seed, ['push', 'origin', DEFAULT]);
    await git(seed, ['checkout', '-b', 'ali/sync']);
    await fs.writeFile(path.join(seed, 'KnowledgeBase', 'f.md'), 'two\n');
    await git(seed, ['commit', '-am', 'change']);
    await git(seed, ['push', 'origin', 'ali/sync']);

    const wsDir = (id: string) => path.join(root, 'workspaces', id);
    const defaultId = workspaceIdForBranch(DEFAULT);
    const ownId = workspaceIdForBranch('ali/sync');
    await git(root, ['clone', '-b', DEFAULT, upstream, path.join(wsDir(defaultId), 'knowledge-base')]);
    await git(root, ['clone', '-b', 'ali/sync', upstream, path.join(wsDir(ownId), 'knowledge-base')]);
    const gitService = new GitService(
      { getWorkspacePath: async (id: string) => wsDir(id) } as unknown as WorkspaceService,
      new WorkflowHooks(),
      testKbContext(),
    );
    const fetchDefault = () => git(path.join(wsDir(defaultId), 'knowledge-base'), ['fetch', '--prune', 'origin']);
    const fromDefault = () => gitService.changedPathsForPr(defaultId, DEFAULT, 'ali/sync', { fetch: false });
    const fromOwn = () => gitService.changedPathsForPr(ownId, DEFAULT, 'ali/sync');

    await fetchDefault();
    expect(await fromDefault()).toEqual(await fromOwn());
    expect(await fromDefault()).not.toEqual([]);

    // The change lands on the default branch another way: the request now proposes nothing.
    await git(seed, ['checkout', DEFAULT]);
    await git(seed, ['merge', '--no-ff', '-m', 'landed elsewhere', 'ali/sync']);
    await git(seed, ['push', 'origin', DEFAULT]);
    await fetchDefault();
    expect(await fromDefault()).toEqual([]);
    expect(await fromOwn()).toEqual([]);
  });
});
