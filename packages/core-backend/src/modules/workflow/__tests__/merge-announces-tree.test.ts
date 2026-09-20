import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_BRANCH, type WorkflowEvent } from '@bevel-software/platform-shared';

import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import type { WorkflowEventBus } from '../event-bus.js';
import type { Database } from '../../database/connection.js';
import { WorkflowService } from '../workflow.service.js';

/**
 * APPLYING A CHANGE REQUEST ANNOUNCES THE TREE IT REWROTE.
 *
 * The bug, found on staging: an approved `.tool` merged into the default
 * branch stayed invisible — to every open MCP connection and every browser —
 * for tens of seconds, once for 42.
 *
 * Why it was invisible is the whole point of this file. `mergePr` runs
 * `git merge --no-ff` in the TARGET branch's own workspace and pushes the
 * result, so the working tree already holds the merged files. The pull that
 * follows is then a no-op: the clone is at origin, `treeChanged` is false, and
 * `pullWorkspace` announces nothing — it announces a pull that moved the tree,
 * and this one did not move it, the merge did.
 *
 * Nothing else covered the gap. `change-request-merged` carries no branch and
 * no workspace, so `catalog-cache-invalidation.ts` cannot act on it; a later
 * `POST /api/sync/<branch>` answers "up-to-date" without pulling for the same
 * reason. The catalogs were left holding a scan of a tree that no longer
 * existed until an unrelated default-branch write dropped them, or their TTL
 * ran out — which is exactly why an unrelated write made the staleness vanish.
 */

const KB_DIR = 'knowledge-base';
const HEAD = 'someone/add-a-tool';
const USER = { id: 'u1', email: 'someone@x.com', name: 'Someone' };

function noopAccessControl(): IAccessControl {
  return { invalidate: vi.fn() } as unknown as IAccessControl;
}

function makeSvc(opts: { base?: string; pullTreeChanged?: boolean; mergeThrows?: Error } = {}) {
  const base = opts.base ?? DEFAULT_BRANCH;
  const events: WorkflowEvent[] = [];
  const bus = {
    emit: vi.fn((payload: WorkflowEvent) => {
      events.push(payload);
      return payload;
    }),
  } as unknown as WorkflowEventBus;

  const reviewWorkflow = {
    mergePr: opts.mergeThrows
      ? vi.fn().mockRejectedValue(opts.mergeThrows)
      : vi.fn().mockResolvedValue({ prNumber: 1, sha: 'merged-sha', mergedAt: 't' }),
  } as unknown as IReviewWorkflowService;

  const git = {
    fetch: vi.fn().mockResolvedValue(undefined),
    // The real shape after a local merge + push: the clone is already at
    // origin, so the pull moves nothing.
    pull: vi.fn().mockResolvedValue({ treeChanged: opts.pullTreeChanged ?? false }),
    readFileAtRef: vi.fn().mockResolvedValue(null), // no roles.yaml either side
    commitFile: vi.fn(),
    push: vi.fn(),
  } as unknown as GitService;

  const prs = {
    getPr: vi.fn().mockResolvedValue({ branch: HEAD, base }),
    getPrDetail: vi.fn().mockResolvedValue({ headSha: 'sha', approvals: [], state: 'open', title: 'T', base }),
    invalidateDetailCache: vi.fn(),
  } as unknown as PullRequestService;

  const workspaceService = {
    getOrCreateForBranch: vi.fn(async (branch: string) => ({ id: encodeURIComponent(branch) })),
    getWorkspacePath: vi.fn(async (id: string) => `/tmp/${id}`),
  } as unknown as WorkspaceService;

  const svc = new WorkflowService(
    {} as unknown as Database,
    git,
    prs,
    reviewWorkflow,
    workspaceService,
    noopAccessControl(),
    { acquire: vi.fn(), release: vi.fn() } as unknown as FileLockService,
    {} as unknown as PendingCommitsService,
    KB_DIR,
    bus,
  );
  // Branch retirement is git IO past the announcement and irrelevant here.
  vi.spyOn(svc as unknown as { retireMergedSourceBranch: () => Promise<void> }, 'retireMergedSourceBranch')
    .mockResolvedValue(undefined);

  const merge = () => svc.mergeChangeRequest(1, USER, 'sha', [], 'open', 'T', base, 'w1', { bypass: false });
  const treeEvents = () => events.filter((e) => e.kind === 'fs-tree-changed');
  return { svc, merge, events, treeEvents, git, bus };
}

describe('applying a change request announces the tree it rewrote', () => {
  it('announces the default branch even though the post-merge pull moved nothing', async () => {
    const { merge, treeEvents } = makeSvc();

    await merge();

    // Exactly the signal `catalog-cache-invalidation.ts` subscribes to, naming
    // the workspace the merge rewrote — so the tool and skill catalogs are
    // dropped before the next `list_tools` reads them.
    expect(treeEvents()).toEqual([
      { kind: 'fs-tree-changed', workspaceId: encodeURIComponent(DEFAULT_BRANCH), branch: DEFAULT_BRANCH },
    ]);
  });

  /**
   * The rare path where the clone WAS behind — someone else pushed between the
   * merge and the pull. The pull then announces the same tree, and a second
   * event buys a duplicate catalog re-scan and a duplicate browser refetch for
   * a change already reported.
   */
  it('does not announce twice when the pull already did', async () => {
    const { merge, treeEvents } = makeSvc({ pullTreeChanged: true });

    await merge();

    expect(treeEvents()).toHaveLength(1);
  });

  /** The announcement comes BEFORE the merge is reported, so a session that reacts to
   * `change-request-merged` by refetching cannot read a catalog that is still stale. */
  it('announces before it says the request was applied', async () => {
    const { merge, events } = makeSvc();

    await merge();

    const tree = events.findIndex((e) => e.kind === 'fs-tree-changed');
    const merged = events.findIndex((e) => e.kind === 'change-request-merged');
    expect(tree).toBeGreaterThanOrEqual(0);
    expect(merged).toBeGreaterThan(tree);
  });

  /**
   * The catalogs read the default branch and nothing else, and a merge into
   * some other base rewrote a tree they never scanned.
   */
  it('says nothing about a merge into another base', async () => {
    const { merge, treeEvents } = makeSvc({ base: 'team/staging' });

    await merge();

    expect(treeEvents()).toEqual([]);
  });

  /** A merge that did not happen rewrote nothing. */
  it('says nothing when the merge failed', async () => {
    const { merge, treeEvents } = makeSvc({ mergeThrows: new Error('merge exploded') });

    await expect(merge()).rejects.toThrow('merge exploded');

    expect(treeEvents()).toEqual([]);
  });
});
