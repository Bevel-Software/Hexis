import { desc, eq } from 'drizzle-orm';
import { logger } from '../../../shared/logging.js';

const log = logger('cr');
import type {
  FileApprovalState,
  IPullRequestService,
  PrReviewComment,
  PullRequestDetail,
  PullRequestFile,
  PullRequestState,
  PullRequestSummary,
  IGitService,
} from '@bevel-software/platform-shared';
import { isFolderPlaceholder } from '@bevel-software/platform-shared';
import type { Database } from '../../database/connection.js';
import { changeRequests } from '../../database/schema.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { AccessUnreadableError } from '../../access-model/access-errors.js';
import { WorkflowValidationError } from '../../../shared/domain-errors.js';
import { canonicalEmail, hashEmail } from '../../../shared/email-identity.js';
import { changeRequestLink, changeRequestLinkBase } from './change-request-link.js';

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
   * What each listed summary is ROUTED by: its touched paths with the
   * empty-folder placeholders kept. A summary never shows a placeholder, but a
   * request that only creates a folder still belongs to that folder's owners,
   * so `listPrsForOwnerEmail` matches on these. Held beside the summaries the
   * list cache stores, so it lives and dies with them.
   */
  private routingPaths = new WeakMap<PullRequestSummary, string[]>();
  /**
   * Per-CR detail cache, keyed by `${workspaceId ?? 'global'}:${viewer}:${number}`.
   * The payload includes per-file approvals resolved against the caller's
   * workspace KB, so it can't be shared across workspaces or viewers. The stored
   * head SHA lets a new commit between fetches show up as a miss (diffs changed)
   * instead of stale data.
   */
  private detailCache = new Map<
    string,
    { at: number; headSha: string; baseSha: string; value: PullRequestDetail }
  >();

  /**
   * Optional — set by the composition root after ReviewWorkflowService exists.
   * Setter-based wiring (not constructor) because PullRequestService is itself
   * a dependency of ReviewWorkflowService's routes, and we want both to live
   * in the same container without a forward-declaration dance.
   */
  private detailEnricher: PrDetailEnricher | null = null;

  /** Origin + path prefix change-request links are built on; null when none is configured. */
  private readonly linkBase: string | null;

  /**
   * Bumped by every invalidation. A read captures it before touching the DB and
   * caches its result only if it is unchanged afterwards — otherwise a read that
   * started before a mutation could republish the pre-mutation row for a TTL.
   */
  private cacheGeneration = 0;

  constructor(
    private readonly db: Database,
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly gitService: IGitService,
    /** Configured public frontend address; null keeps `url` relative (with a `urlNote`). */
    publicFrontendUrl: string | null = null,
  ) {
    this.linkBase = changeRequestLinkBase(publicFrontendUrl);
  }

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
      // The in-app change-request route, absolute when a public address is
      // configured so an agent can hand it to a person.
      ...changeRequestLink(row.number, this.linkBase),
      // Only an OPEN request can still be retried, so only it reports a refusal.
      lastApplyFailure:
        row.state === 'open' && row.applyFailureReason && row.applyFailedAt
          ? {
              reason: row.applyFailureReason,
              conflicts: row.applyFailureConflicts === true,
              at: row.applyFailedAt.toISOString(),
              byName: row.applyFailedByName ?? '',
            }
          : null,
    };
  }

  /**
   * Cheap touched-paths for a CR row (empty when no workspace exists yet),
   * placeholders included — see {@link summaryOf} for what a summary shows.
   */
  private async touchedPathsFor(
    row: ChangeRequestRow,
    workspaceId: string | null,
    opts: { fetch?: boolean } = {},
  ): Promise<string[]> {
    if (!workspaceId) return [];
    return this.gitService
      .changedPathsForPr(workspaceId, row.targetBranch, row.sourceBranch, opts)
      .catch((err) => {
        // Best-effort, but log it: an empty result silently hides a CR from the
        // owner-routing match in `listPrsForOwnerEmail`, so a swallowed failure
        // shouldn't be invisible.
        log.warn(
          `changedPathsForPr failed for #${row.number} (${row.sourceBranch} → ${row.targetBranch}) in ${workspaceId}:`,
          { err },
        );
        return [] as string[];
      });
  }

  /**
   * The summary of a CR row. The empty-folder placeholder is never content,
   * so it is not a touched path on the summary: it would inflate the file
   * count a list shows. The unfiltered paths are kept for routing, where a
   * folder-only request must still reach the folder's owners.
   */
  private async summaryOf(
    row: ChangeRequestRow,
    workspaceId: string | null,
    opts: { fetch?: boolean } = {},
  ): Promise<PullRequestSummary> {
    const touched = await this.touchedPathsFor(row, workspaceId, opts);
    const summary = this.rowToSummary(row, touched.filter((p) => !isFolderPlaceholder(p)));
    this.routingPaths.set(summary, touched);
    return summary;
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
    const generation = this.cacheGeneration;
    const rows = await this.db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.state, 'open'))
      .orderBy(desc(changeRequests.createdAt));
    // ONE fetch of the clone for the whole list, not one per request.
    //
    // Every summary needs the request's touched paths, and
    // `changedPathsForPr` fetches the two refs it is about before diffing
    // them. That is a network round trip PER OPEN REQUEST, on a list that is
    // re-read after every proposal and polled every 60s while the tab is
    // visible — measured at ~0.55s per additional open request, which is the
    // "very slow loading" this list was reported for. `ensureRemotesFetched`
    // refreshes every `origin/*` ref of the clone in one round trip and
    // shares an in-flight fetch between callers — so the two list endpoints
    // the tree calls together cost one fetch BETWEEN them instead of two per
    // request.
    //
    // `force` on a fresh read, for the same reason the read is fresh at all:
    // it exists because the caller knows the remote just moved, and a fetch
    // skipped by its 30s TTL would answer about a request whose branch this
    // clone has not seen — which is the request missing from its own
    // author's tree. A non-fresh poll keeps the TTL; `changedPathsForPr`
    // fetches for itself if a branch is missing even then, so the worst a
    // stale window can do is report a known branch one poll behind.
    //
    // Best-effort, exactly as the per-request fetch was: a request whose diff
    // cannot be computed degrades to no touched paths as before.
    if (workspaceId && rows.length > 0) {
      await this.workspaceService
        .ensureRemotesFetched(workspaceId, { force: opts.fresh === true })
        .catch(() => undefined);
    }
    const summaries = await Promise.all(
      rows.map((row) => this.summaryOf(row, workspaceId, { fetch: false })),
    );
    if (generation === this.cacheGeneration) {
      this.cachedList.set(cacheKey, { at: now, value: summaries });
    }
    return summaries;
  }

  async listPrsAuthoredBy(
    loginOrEmail: string,
    opts: { fresh?: boolean } = {},
  ): Promise<PullRequestSummary[]> {
    const needle = canonicalEmail(loginOrEmail);
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
    const normalized = canonicalEmail(email);
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
    const routedBy = (pr: PullRequestSummary) => this.routingPaths.get(pr) ?? pr.touchedNodePaths;
    for (const pr of prs) {
      if (routedBy(pr).length === 0) continue;
      for (const ref of [pr.branch, pr.base]) {
        let bucket = pathsByRef.get(ref);
        if (!bucket) {
          bucket = new Set();
          pathsByRef.set(ref, bucket);
        }
        for (const p of routedBy(pr)) bucket.add(p);
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
      if (routedBy(pr).length === 0) continue;
      const headWrite = writeByRef.get(pr.branch);
      const baseWrite = writeByRef.get(pr.base);
      const matched = routedBy(pr).some(
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
    return this.summaryOf(row, workspaceId);
  }

  async getPrDetail(
    prNumber: number,
    opts: { fresh?: boolean; workspaceId?: string; viewerEmail?: string; patches?: boolean } = {},
  ): Promise<PullRequestDetail | null> {
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new WorkflowValidationError('PR number must be a positive integer');
    }
    const generation = this.cacheGeneration;
    const row = await this.findRow(prNumber);
    if (!row) return null;

    const now = Date.now();
    const viewerKey = opts.viewerEmail ? canonicalEmail(opts.viewerEmail) : 'anon';
    const workspaceId = await this.resolveWorkspaceId(opts.workspaceId);
    const cacheKey = `${workspaceId ?? 'global'}:${viewerKey}:${prNumber}`;

    // Head/base SHAs + file diffs are computed live from git so a force-push or
    // new commit is always reflected. Without any workspace we can't diff — a
    // rare cold-start case; return an empty file set rather than failing.
    let baseSha = '';
    let headSha = '';
    let files: PullRequestFile[] = [];
    let forkPoint: { mergeBaseSha: string | null; behind: boolean } = {
      mergeBaseSha: null,
      behind: false,
    };
    if (workspaceId) {
      const shas = await this.gitService.resolvePrShas(
        workspaceId,
        row.targetBranch,
        row.sourceBranch,
      );
      baseSha = shas.baseSha;
      headSha = shas.headSha;
      // The file list is pinned to the SHAs just resolved (`at`), so it and
      // the `headSha` approvals pin against describe the same commits even if
      // another fetch lands on this workspace in between, and the second
      // fetch of the same two refs is gone. `patches: false` is for the
      // internal detail an approve / withdraw / revert fetches to pin its
      // work: those never read `files[].patch`, and generating it cost one git
      // subprocess per changed file per click. The detail served to clients
      // keeps its patches, so the published payload is unchanged.
      files = await this.gitService.changedFilesForPr(
        workspaceId,
        row.targetBranch,
        row.sourceBranch,
        { at: { baseSha, headSha }, ...(opts.patches === false ? { patchCap: 0 } : {}) },
      );
      // Pinned to the same two commits as the file list, so "needs updating"
      // and the diff it qualifies can never describe different heads.
      forkPoint = await this.gitService.forkPointForPr(workspaceId, { baseSha, headSha });
    }

    // Validated cache hit: TTL fresh AND head SHA unchanged since we cached.
    const cached = this.detailCache.get(cacheKey);
    if (
      !opts.fresh &&
      cached &&
      now - cached.at < DETAIL_CACHE_TTL_MS &&
      cached.headSha === headSha &&
      // The target moving on changes `behind` without touching the head.
      cached.baseSha === baseSha
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
            log.warn(`listComments failed for #${prNumber}:`, { err });
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
              // An unreadable access tree fails the whole read (503): a detail
              // with empty approvals would tell the merge gate "nothing to
              // approve", and a reviewer nothing at all.
              if (err instanceof AccessUnreadableError) throw err;
              log.warn(`getApprovalStates failed for #${prNumber}:`, { err });
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
        log.warn(`viewerCanBypassMerge lookup failed for #${prNumber}:`, { err });
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

    const viewerCanUpdate = computeViewerCanUpdate({
      state: summary.state,
      authorId: summary.authorId,
      viewerEmail: opts.viewerEmail,
      viewerCanBypassMerge,
      approvals,
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
      mergeBaseSha: forkPoint.mergeBaseSha,
      behind: summary.state === 'open' && forkPoint.behind,
      viewerCanUpdate,
    };

    // A patch-less detail is an internal read; it must not be served to the
    // next client poll as if it were the full one. Nor may a read a mutation
    // overtook: its row predates that mutation.
    if (opts.patches !== false && generation === this.cacheGeneration) {
      this.detailCache.set(cacheKey, {
        at: now,
        headSha: detail.headSha,
        baseSha: detail.baseSha,
        value: detail,
      });
    }
    return detail;
  }

  /**
   * Evict every cached detail for `prNumber` (one entry per workspace/viewer
   * that fetched it). Called by mutations that invalidate the view (merge,
   * cancel, comment). Keeps the cache-busting plumbing internal to this service.
   */
  invalidateDetailCache(prNumber: number): void {
    this.cacheGeneration++;
    const suffix = `:${prNumber}`;
    for (const key of this.detailCache.keys()) {
      if (key.endsWith(suffix)) this.detailCache.delete(key);
    }
    this.cachedList.clear();
  }

  /**
   * Evict the CR-list caches alone. Each list entry carries `touchedNodePaths`
   * resolved against a workspace's tree at the time; a remote sync that moved
   * that tree makes them stale without touching any one request.
   */
  invalidateListCache(): void {
    this.cacheGeneration++;
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

/**
 * Pure predicate for `viewerCanUpdate` — who may merge a request's target
 * into it. The request's author (it is their proposal to bring up to date)
 * and anyone who may apply it, by the merge gate's own reading: every file
 * the gate binds (`isGateRelevant`) already approved or approvable by this
 * viewer — files outside the gate (`inMergeGate: false`) need nobody's
 * approval to apply, so they cannot withhold Update either — or an admin, who
 * may apply over missing approvals. That exemption holds only for a file whose
 * approvers were actually resolved (`eligibilityResolved`): when the access
 * tree could not be read, every file reads as outside the gate, and that
 * emptiness must not become a grant — Update fails closed. Fail-closed on no viewer, and nothing but an open request can be
 * updated. The update route enforces exactly this.
 */
export function computeViewerCanUpdate(input: {
  state: PullRequestState;
  authorId: string | undefined;
  viewerEmail: string | undefined;
  viewerCanBypassMerge: boolean;
  approvals: FileApprovalState[];
}): boolean {
  if (input.state !== 'open') return false;
  if (!input.viewerEmail) return false;
  const viewerIsAuthor = !!(input.authorId && input.authorId === hashEmail(input.viewerEmail));
  const viewerMayApply =
    input.approvals.length > 0 &&
    input.approvals.every(
      (a) => (a.eligibilityResolved === true && !a.inMergeGate) || a.isApproved || a.viewerCanApprove,
    );
  return viewerIsAuthor || input.viewerCanBypassMerge || viewerMayApply;
}

export const __testing = {
  computeViewerCanCancel,
  computeViewerCanUpdate,
};
