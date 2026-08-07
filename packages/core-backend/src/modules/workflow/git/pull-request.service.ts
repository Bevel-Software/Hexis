import { desc, eq } from 'drizzle-orm';
import type {
  FileApprovalState,
  IPullRequestService,
  PrReviewComment,
  PullRequestDetail,
  PullRequestFile,
  PullRequestState,
  PullRequestSummary,
} from '@bevel-software/platform-shared';
import type { Database } from '../../database/connection.js';
import { changeRequests } from '../../database/schema.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { GitService } from './git.service.js';
import { WorkflowValidationError } from '../workflow.errors.js';
import { hashEmail } from '../../../shared/hash-email.js';

const LIST_PR_CACHE_TTL_MS = 30_000;
const DETAIL_CACHE_TTL_MS = 30_000;

type ChangeRequestRow = typeof changeRequests.$inferSelect;

/**
 * The slice of the review-workflow service this module needs to compose detail
 * responses. Kept narrow (just what `getPrDetail` stitches in) so the PR
 * service doesn't depend on the full workflow interface — and so the circular
 * relationship in the composition root is explicit and minimal.
 */
export interface PrDetailEnricher {
  listComments(prNumber: number): Promise<PrReviewComment[]>;
  /**
   * Per-file approval state. `baseBranch` selects the access tree (resolved
   * against `origin/<baseBranch>`); `workspaceId` is optional and gates the
   * git lookup — without it, entries come back with empty eligibility.
   * `viewerEmail` pre-computes `viewerCanApprove` per file for the UI's
   * Approve-button visibility.
   */
  getApprovalStates(
    prNumber: number,
    files: PullRequestFile[],
    headSha: string,
    baseBranch: string,
    prAuthorIdHash: string | null,
    workspaceId?: string,
    viewerEmail?: string,
  ): Promise<FileApprovalState[]>;
  /**
   * Pure derivation of the merge gate. Same function the merge route calls to
   * re-validate server-side before executing the merge.
   */
  evaluateMergeGate(input: {
    prNumber: number;
    state: PullRequestState;
    approvals: FileApprovalState[];
  }): { mergeable: boolean; reasons: string[]; warnings: string[] };
}

/**
 * Reads change requests from the app's own DB (`change_requests`) and computes
 * their diff + SHAs locally from git — no provider PR API. This is what lets the
 * KB live on ANY git host: a change request is a DB row plus two branches, so
 * the remote only has to store commits.
 *
 * The durable facts (pairing, title/body, author, state) live in the row; the
 * head/base SHAs, file list, and diffs are derived live from git so a new commit
 * or force-push is always reflected. Comments + per-file approvals + the merge
 * gate are stitched in from the review-workflow service (also DB-backed).
 */
export class PullRequestService implements IPullRequestService {
  /**
   * Per-workspace CR-list cache. `touchedNodePaths` on each summary are resolved
   * against a specific workspace's clone, so a single global entry could serve
   * one workspace's touched-paths to another and hide matching CRs in
   * `listPrsForOwnerEmail`. Key by the resolved workspace id (or `'global'` when
   * none exists yet) so each keeps its own view.
   */
  private cachedList = new Map<string, { at: number; value: PullRequestSummary[] }>();
  /**
   * Per-CR detail cache, keyed by `${workspaceId ?? 'global'}:${viewer}:${number}`.
   * The payload includes per-file approvals resolved against the caller's
   * workspace KB, so it can't be shared across workspaces or viewers. The stored
   * head SHA lets a new commit between fetches show up as a miss (diffs changed)
   * instead of stale data.
   */
  private detailCache = new Map<
    string,
    { at: number; headSha: string; value: PullRequestDetail }
  >();

  /**
   * Optional — set by the composition root after ReviewWorkflowService exists.
   * Setter-based wiring (not constructor) because PullRequestService is itself
   * a dependency of ReviewWorkflowService's routes, and we want both to live
   * in the same container without a forward-declaration dance.
   */
  private detailEnricher: PrDetailEnricher | null = null;

  constructor(
    private readonly db: Database,
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly gitService: GitService,
  ) {}

  setDetailEnricher(enricher: PrDetailEnricher): void {
    this.detailEnricher = enricher;
  }

  /**
   * A workspace to run repo-global git reads against. Any clone works (they all
   * track the same origin), so a caller's own workspace is preferred but any
   * on-disk clone is fine. Null only when no workspace has been created yet.
   */
  private async resolveWorkspaceId(preferred?: string): Promise<string | null> {
    if (preferred) return preferred;
    return this.workspaceService.findAnyWorkspaceId();
  }

  private rowToSummary(row: ChangeRequestRow, touchedNodePaths: string[]): PullRequestSummary {
    return {
      number: row.number,
      title: row.title,
      // `login` is no longer a provider account — there's no service account
      // opening CRs anymore. Derive it from the email HASH (not the local-part)
      // so no email-derived identifier is exposed to API consumers; `authorId`
      // covers identity and `appAuthor.name` is what user-facing surfaces render.
      authorId: hashEmail(row.authorEmail),
      author: { login: `user-${hashEmail(row.authorEmail).slice(0, 12)}`, name: row.authorName },
      appAuthor: { name: row.authorName },
      branch: row.sourceBranch,
      base: row.targetBranch,
      state: row.state as PullRequestState,
      createdAt: row.createdAt.toISOString(),
      touchedNodePaths,
      // Provider reviews are gone; the real approval state lives in the detail
      // view (per-file, DB-backed). The summary badge is derived there.
      review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
      // In-app change-request route; there's no external PR URL to link to.
      url: `/change-requests/${row.number}`,
    };
  }

  /** Cheap touched-paths for a CR row (empty when no workspace exists yet). */
  private async touchedPathsFor(
    row: ChangeRequestRow,
    workspaceId: string | null,
  ): Promise<string[]> {
    if (!workspaceId) return [];
    return this.gitService
      .changedPathsForPr(workspaceId, row.targetBranch, row.sourceBranch)
      .catch((err) => {
        // Best-effort, but log it: an empty result silently hides a CR from the
        // owner-routing match in `listPrsForOwnerEmail`, so a swallowed failure
        // shouldn't be invisible.
        console.warn(
          `[cr] changedPathsForPr failed for #${row.number} (${row.sourceBranch} → ${row.targetBranch}) in ${workspaceId}:`,
          err,
        );
        return [] as string[];
      });
  }

  async listOpenPrs(
    opts: { fresh?: boolean; workspaceId?: string } = {},
  ): Promise<PullRequestSummary[]> {
    const now = Date.now();
    const workspaceId = await this.resolveWorkspaceId(opts.workspaceId);
    const cacheKey = workspaceId ?? 'global';
    const cached = this.cachedList.get(cacheKey);
    if (!opts.fresh && cached && now - cached.at < LIST_PR_CACHE_TTL_MS) {
      return cached.value;
    }
    const rows = await this.db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.state, 'open'))
      .orderBy(desc(changeRequests.createdAt));
    const summaries = await Promise.all(
      rows.map(async (row) => this.rowToSummary(row, await this.touchedPathsFor(row, workspaceId))),
    );
    this.cachedList.set(cacheKey, { at: now, value: summaries });
    return summaries;
  }

  async listPrsAuthoredBy(
    loginOrEmail: string,
    opts: { fresh?: boolean } = {},
  ): Promise<PullRequestSummary[]> {
    const needle = loginOrEmail.trim().toLowerCase();
    if (!needle) return [];
    const prs = await this.listOpenPrs(opts);
    const needleIsEmail = needle.includes('@');
    const needleHash = needleIsEmail ? hashEmail(needle) : null;
    return prs.filter((p) => {
      if (needleHash) return !!(p.authorId && p.authorId === needleHash);
      return p.author.login.toLowerCase() === needle;
    });
  }

  async listPrsForOwnerEmail(
    workspaceId: string,
    email: string,
    opts: { fresh?: boolean } = {},
  ): Promise<PullRequestSummary[]> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return [];
    const prs = await this.listOpenPrs({ ...opts, workspaceId });

    // Access lookup must be ref-aware: a PR that *broadens* access to include
    // the user must route to them even when their working tree is on a
    // different branch. We resolve against each PR's head ref (post-merge
    // state) and its base ref (existing access tree) and union — so PRs that
    // remove the user's access still surface to them for review.
    if (prs.length > 0) {
      await this.workspaceService.ensureRemotesFetched(workspaceId);
    }

    // Batch-resolve access per ref. Many PRs overlap on base and paths, so
    // collecting unique (ref, path) pairs and resolving them in one round keeps
    // the ls-tree/git-show fan-out bounded even with dozens of open PRs.
    const pathsByRef = new Map<string, Set<string>>();
    for (const pr of prs) {
      if (pr.touchedNodePaths.length === 0) continue;
      for (const ref of [pr.branch, pr.base]) {
        let bucket = pathsByRef.get(ref);
        if (!bucket) {
          bucket = new Set();
          pathsByRef.set(ref, bucket);
        }
        for (const p of pr.touchedNodePaths) bucket.add(p);
      }
    }
    const writeByRef = new Map<string, Map<string, boolean>>();
    await Promise.all(
      Array.from(pathsByRef.entries()).map(async ([ref, paths]) => {
        const map = await this.accessControl.canWriteBatchAtRef(
          workspaceId,
          ref,
          normalized,
          Array.from(paths),
        );
        if (map) writeByRef.set(ref, map);
      }),
    );

    const authorIdForEmail = hashEmail(normalized);
    const matches: PullRequestSummary[] = [];
    for (const pr of prs) {
      // A PR the user opened themselves always belongs in their "for you" list,
      // even if none of the touched files are within their write scope.
      if (pr.authorId && pr.authorId === authorIdForEmail) {
        matches.push(pr);
        continue;
      }
      if (pr.touchedNodePaths.length === 0) continue;
      const headWrite = writeByRef.get(pr.branch);
      const baseWrite = writeByRef.get(pr.base);
      const matched = pr.touchedNodePaths.some(
        (p) => headWrite?.get(p) === true || baseWrite?.get(p) === true,
      );
      if (matched) matches.push(pr);
    }
    return matches;
  }

  async getPr(prNumber: number): Promise<PullRequestSummary | null> {
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new WorkflowValidationError('PR number must be a positive integer');
    }
    const row = await this.findRow(prNumber);
    if (!row) return null;
    const workspaceId = await this.resolveWorkspaceId();
    return this.rowToSummary(row, await this.touchedPathsFor(row, workspaceId));
  }

  async getPrDetail(
    prNumber: number,
    opts: { fresh?: boolean; workspaceId?: string; viewerEmail?: string } = {},
  ): Promise<PullRequestDetail | null> {
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new WorkflowValidationError('PR number must be a positive integer');
    }
    const row = await this.findRow(prNumber);
    if (!row) return null;

    const now = Date.now();
    const viewerKey = opts.viewerEmail ? opts.viewerEmail.trim().toLowerCase() : 'anon';
    const workspaceId = await this.resolveWorkspaceId(opts.workspaceId);
    const cacheKey = `${workspaceId ?? 'global'}:${viewerKey}:${prNumber}`;

    // Head/base SHAs + file diffs are computed live from git so a force-push or
    // new commit is always reflected. Without any workspace we can't diff — a
    // rare cold-start case; return an empty file set rather than failing.
    let baseSha = '';
    let headSha = '';
    let files: PullRequestFile[] = [];
    if (workspaceId) {
      const shas = await this.gitService.resolvePrShas(
        workspaceId,
        row.targetBranch,
        row.sourceBranch,
      );
      baseSha = shas.baseSha;
      headSha = shas.headSha;
      files = await this.gitService.changedFilesForPr(
        workspaceId,
        row.targetBranch,
        row.sourceBranch,
      );
    }

    // Validated cache hit: TTL fresh AND head SHA unchanged since we cached.
    const cached = this.detailCache.get(cacheKey);
    if (
      !opts.fresh &&
      cached &&
      now - cached.at < DETAIL_CACHE_TTL_MS &&
      cached.headSha === headSha
    ) {
      return cached.value;
    }

    const summary = this.rowToSummary(row, files.map((f) => f.path));

    // Comments + approvals come from our own DB via the review-workflow service.
    // The enricher is optional — if it isn't wired yet (startup ordering,
    // isolated tests) we return empty lists rather than blocking the fetch.
    const [comments, approvals] = this.detailEnricher
      ? await Promise.all([
          this.detailEnricher.listComments(prNumber).catch((err) => {
            console.warn(`[cr] listComments failed for #${prNumber}:`, err);
            return [] as PrReviewComment[];
          }),
          this.detailEnricher
            .getApprovalStates(
              prNumber,
              files,
              headSha,
              summary.base,
              summary.authorId ?? null,
              workspaceId ?? undefined,
              opts.viewerEmail,
            )
            .catch((err) => {
              console.warn(`[cr] getApprovalStates failed for #${prNumber}:`, err);
              return [] as FileApprovalState[];
            }),
        ])
      : [[] as PrReviewComment[], [] as FileApprovalState[]];

    const gate = this.detailEnricher
      ? this.detailEnricher.evaluateMergeGate({
          prNumber,
          state: summary.state,
          approvals,
        })
      : { mergeable: false, reasons: ['review workflow unavailable'], warnings: [] };

    // Mirror the backend's merge-bypass admin check (same `canWriteAtRef` call
    // `mergePr` runs) so the frontend can hide/disable the bypass affordance for
    // non-admins. Best-effort — null/error → false (safe default). The merge
    // route re-checks server-side; this is a UX hint, not a security boundary.
    let viewerCanBypassMerge = false;
    if (workspaceId && opts.viewerEmail) {
      try {
        const isAdmin = await this.accessControl.canWriteAtRef(
          workspaceId,
          `origin/${summary.base}`,
          opts.viewerEmail,
          'roles.yaml',
        );
        viewerCanBypassMerge = isAdmin === true;
      } catch (err) {
        console.warn(`[cr] viewerCanBypassMerge lookup failed for #${prNumber}:`, err);
      }
    }

    const viewerCanCancel = computeViewerCanCancel({
      state: summary.state,
      authorId: summary.authorId,
      viewerEmail: opts.viewerEmail,
      viewerCanBypassMerge,
      // The reject route's third grant (see `rejectChangeRequest`): write on
      // every changed file at origin/<base>. Derived from the per-file
      // `viewerCanApprove` flags — the SAME `canWriteBatchAtRef` predicate the
      // route enforces — so the hint cannot drift from the enforcement.
      viewerWritesAllFiles: approvals.length > 0 && approvals.every((a) => a.viewerCanApprove),
    });

    const detail: PullRequestDetail = {
      ...summary,
      body: row.body,
      headSha,
      baseSha,
      files,
      comments,
      approvals,
      mergeableInBevel: gate.mergeable,
      mergeBlockedReasons: gate.reasons,
      mergeWarnings: gate.warnings,
      viewerCanBypassMerge,
      viewerCanCancel,
    };

    this.detailCache.set(cacheKey, { at: now, headSha: detail.headSha, value: detail });
    return detail;
  }

  /**
   * Evict every cached detail for `prNumber` (one entry per workspace/viewer
   * that fetched it). Called by mutations that invalidate the view (merge,
   * cancel, comment). Keeps the cache-busting plumbing internal to this service.
   */
  invalidateDetailCache(prNumber: number): void {
    const suffix = `:${prNumber}`;
    for (const key of this.detailCache.keys()) {
      if (key.endsWith(suffix)) this.detailCache.delete(key);
    }
    this.cachedList.clear();
  }

  private async findRow(prNumber: number): Promise<ChangeRequestRow | null> {
    const [row] = await this.db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.number, prNumber))
      .limit(1);
    return row ?? null;
  }
}

/**
 * Pure predicate for the `viewerCanCancel` hint. The viewer can cancel iff
 * the PR is open AND they're the author (hash-match against the stored
 * author), an admin (`viewerCanBypassMerge` is the proxy — same
 * `canWriteAtRef('roles.yaml')` predicate), or they hold write on EVERY
 * changed file (`viewerWritesAllFiles`) — the reject route's full
 * authorization set, mirrored exactly so the hint never claims less (or
 * more) than the server enforces. Fail-closed: no viewer email → false,
 * whatever the grants say.
 */
export function computeViewerCanCancel(input: {
  state: PullRequestState;
  authorId: string | undefined;
  viewerEmail: string | undefined;
  viewerCanBypassMerge: boolean;
  viewerWritesAllFiles: boolean;
}): boolean {
  if (input.state !== 'open') return false;
  if (!input.viewerEmail) return false;
  const viewerIsAuthor = !!(input.authorId && input.authorId === hashEmail(input.viewerEmail));
  return viewerIsAuthor || input.viewerCanBypassMerge || input.viewerWritesAllFiles;
}

export const __testing = {
  computeViewerCanCancel,
};
