import { desc, eq, inArray } from 'drizzle-orm';
import { logger } from '../../../shared/logging.js';

const log = logger('cr');
import type {
  AppliedChangeRef,
  ChangedPathPair,
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

/**
 * The latest moment a change-request row records — its close time when it has
 * one, else its creation time, with `updated_at` folded in for the day
 * something writes it. Deliberately derived from the ROW alone: a time taken
 * from the newest comment or approval would make the same request report
 * different "last changed" moments to a list (which reads no comments) and a
 * detail (which does).
 */
function latestRowMoment(row: {
  createdAt: Date;
  updatedAt: Date | null;
  closedAt: Date | null;
}): string {
  const times = [row.createdAt, row.updatedAt, row.closedAt]
    .filter((d): d is Date => d instanceof Date)
    .map((d) => d.getTime());
  return new Date(Math.max(...times)).toISOString();
}

const LIST_PR_CACHE_TTL_MS = 30_000;
/**
 * How many applied requests' file lists are remembered at once. Each is a
 * short path list, so this is about a deployment that applies requests for
 * years never growing the map without bound; past it the map is cleared whole,
 * and the next list read fills it again.
 */
const MAX_REMEMBERED_APPLIED_CHANGES = 5000;
const DETAIL_CACHE_TTL_MS = 30_000;

type ChangeRequestRow = typeof changeRequests.$inferSelect;

/**
 * Where a change request's files are read from.
 *
 *   - `branches` — the source/target pair, as a live proposal is read.
 *   - `commit`   — the merge commit the row records, as an applied one is.
 *   - `none`     — nothing: there is no durable record of what this request
 *                 proposed, so it has no file list to show.
 */
export type ChangeSource =
  | { kind: 'branches' }
  | { kind: 'commit'; applied: AppliedChangeRef }
  | { kind: 'none' };

/**
 * Which diff a change-request row is read from — asked ONCE, here, by both the
 * list (`touchedPathsFor`) and the by-number detail (`getPrDetail`). The two
 * surfaces answered this question separately before, and so answered it
 * differently: the list gave a declined request no paths while the detail
 * resolved its branch pair, which left `list_change_requests` and the four
 * by-number tools contradicting each other about the same request for the same
 * caller. One function, one answer.
 *
 * An OPEN request is its two branch tips, which is what a proposal IS.
 *
 * An APPLIED one is the merge commit its row records: the branch is retired, and
 * the commit is local, immutable, and holds exactly what landed.
 *
 * A DECLINED one is read from NOTHING, and that is not a degradation:
 *
 *   - The row records no sha, so nothing durable says what the request
 *     proposed. Declining does not retire the source branch (only merging
 *     deletes it), so the branch pair would answer — but it would answer with
 *     what that branch differs by NOW. The author keeps committing to it, and
 *     may open a fresh request from it; reading the declined request would then
 *     present someone else's later work as the proposal that was turned down.
 *   - An empty file set proves no read access downstream, so a declined request
 *     is readable by its author alone — the owner's criterion of 2026-10-02.
 *   - And it asks git nothing, so neither a listing nor a by-number read of a
 *     declined request costs a network round trip.
 *
 * A merged row that records no merge commit (or whose commit this clone has not
 * fetched) lands on `none` too, and fails closed the same way until it can be
 * read in full.
 */
export function changeSourceFor(row: {
  number: number;
  state: string;
  mergedSha?: string | null;
}): ChangeSource {
  if (row.state === 'open') return { kind: 'branches' };
  // The NUMBER travels with the sha, because reading the commit's own change is
  // only sound if the commit is this request's merge commit — and the number is
  // what proves it (the subject ends with `(#<number>)`). A row whose
  // `merged_sha` was written by a merge that made no commit points at the target
  // tip, which is usually another request's merge commit; the git layer rejects
  // that rather than answering with its files. See `merge-commit.ts`.
  if (row.state === 'merged' && row.mergedSha) {
    return { kind: 'commit', applied: { number: row.number, mergeSha: row.mergedSha } };
  }
  return { kind: 'none' };
}

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
   * The files an APPLIED request landed, per clone and merge commit. A merge
   * commit is immutable, so its answer is good for the life of the process;
   * nothing invalidates this, and nothing needs to. See {@link touchedPathsFor}.
   */
  private readonly appliedChanges = new Map<string, { paths: string[]; pairs: ChangedPathPair[] }>();
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

  private rowToSummary(
    row: ChangeRequestRow,
    touchedNodePaths: string[],
    touchedNodeFiles: ChangedPathPair[],
  ): PullRequestSummary {
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
      // The latest moment the ROW records. Nothing stamps `updated_at` on a
      // change request today, so in practice this is the close time of a
      // closed request and the creation time of an open one — the honest
      // answer from the row, with the column folded in for the day something
      // does write it.
      updatedAt: latestRowMoment(row),
      touchedNodePaths,
      touchedNodeFiles,
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
   *
   * WHICH DIFF is {@link changeSourceFor}'s answer — the same one `getPrDetail`
   * takes, so a list and a by-number read never disagree about which files a
   * request has. No state reaches the network per request: an open row is
   * diffed from two branch tips a single whole-clone refresh has already brought
   * up to date (`fetch: false`), an applied one from a local immutable commit,
   * and a declined one from nothing at all.
   *
   * The merge commit also undid the flood finding 1 of Razvan's review named:
   * `publishedPrCommits` answers null for a retired branch, which sent
   * `changedPathsAndPairsForPr` to `fetch` two refs — one of them gone — once PER
   * REQUEST and then logged a warning for each, so a list of a few hundred
   * applied requests opened a few hundred concurrent fetches to answer nothing.
   */
  private async touchedPathsFor(
    row: ChangeRequestRow,
    workspaceId: string | null,
    opts: { fetch?: boolean } = {},
  ): Promise<{ paths: string[]; pairs: ChangedPathPair[] }> {
    const empty = { paths: [] as string[], pairs: [] as ChangedPathPair[] };
    if (!workspaceId) return empty;
    // Best-effort, but logged: an empty result silently hides a CR from the
    // owner-routing match in `listPrsForOwnerEmail`, so a swallowed failure
    // shouldn't be invisible.
    const degrade = (what: string) => (err: unknown) => {
      const where = `#${row.number} (${row.sourceBranch} → ${row.targetBranch}) in ${workspaceId}`;
      // A clone that simply does not hold the merge commit yet is not a failure
      // to shout about — it is this row's turn to be fetched, and the next list
      // read answers it. Warning per request on that would be the log flood the
      // network flood came with.
      if (err instanceof WorkflowValidationError) {
        log.debug(`${what} could not resolve ${where}; answering no touched paths:`, { err });
      } else {
        log.warn(`${what} failed for ${where}:`, { err });
      }
      return empty;
    };
    const source = changeSourceFor(row);
    if (source.kind === 'none') return empty;
    if (source.kind === 'commit') {
      // Remembered once read: a merge commit never changes, so neither does
      // its diff, and a list of a few hundred applied requests would otherwise
      // run four git processes per row on every call. Only an ANSWER is kept.
      // A commit this clone does not hold yet rejects, and that is this row's
      // turn to be fetched, so the next read asks again.
      const key = `${workspaceId}\u0000${source.applied.mergeSha}\u0000${source.applied.number}`;
      const known = this.appliedChanges.get(key);
      if (known) return known;
      return this.gitService
        .changedPathsAndPairsOfAppliedChange(workspaceId, source.applied)
        .then((answer) => {
          if (this.appliedChanges.size >= MAX_REMEMBERED_APPLIED_CHANGES) this.appliedChanges.clear();
          this.appliedChanges.set(key, answer);
          return answer;
        })
        .catch(degrade('changedPathsAndPairsOfAppliedChange'));
    }
    return this.gitService
      .changedPathsAndPairsForPr(workspaceId, row.targetBranch, row.sourceBranch, opts)
      .catch(degrade('changedPathsForPr'));
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
    const summary = this.rowToSummary(
      row,
      touched.paths.filter((p) => !isFolderPlaceholder(p)),
      // Already placeholder-free and roles.yaml-free (see `changedPathPairs`),
      // so the pairs need no filtering of their own here.
      touched.pairs,
    );
    this.routingPaths.set(summary, touched.paths);
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

  /**
   * Every request in `states`, newest first. `['open']` is delegated so the
   * list the app polls keeps its cache; any other set is read straight from
   * the table, because a closed-request read is rare and a second cache keyed
   * on a state set would mostly hold misses.
   *
   * Touched paths are best-effort exactly as on the open list, and no row costs
   * a network call of its own: a MERGED row is diffed from the merge commit it
   * records (local and immutable), and a DECLINED one is not diffed at all —
   * see {@link touchedPathsFor}. A caller that gates on those paths must still
   * treat an empty set as "cannot prove", never as "nothing to protect".
   */
  async listPrsByState(
    states: PullRequestState[],
    opts: { fresh?: boolean; workspaceId?: string } = {},
  ): Promise<PullRequestSummary[]> {
    const wanted = [...new Set(states)];
    if (wanted.length === 0) return [];
    if (wanted.length === 1 && wanted[0] === 'open') return this.listOpenPrs(opts);
    const workspaceId = await this.resolveWorkspaceId(opts.workspaceId);
    const rows = await this.db
      .select()
      .from(changeRequests)
      .where(inArray(changeRequests.state, wanted))
      .orderBy(desc(changeRequests.createdAt));
    // ONE fetch for the whole list, for the reason spelled out on listOpenPrs —
    // and only when an OPEN row is in scope. An open request is diffed from two
    // branch refs, which are as current as the last fetch; a merged one from a
    // commit that cannot change and a declined one from nothing at all. So a
    // listing of closed and merged requests reaches the network not once, which
    // is what the read tools' `state: closed` asks for (and `state: all` keeps
    // its single fetch for the open rows it does contain).
    if (workspaceId && rows.length > 0 && wanted.includes('open')) {
      await this.workspaceService
        .ensureRemotesFetched(workspaceId, { force: opts.fresh === true })
        .catch(() => undefined);
    }
    return Promise.all(rows.map((row) => this.summaryOf(row, workspaceId, { fetch: false })));
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

  /**
   * Did the target change, since the fork point, any file this request also
   * changes? The question behind `needsUpdate`.
   *
   * The intersection is taken over BOTH names of every rename on both sides,
   * because a wrong "no" is the expensive answer: it would open a request on
   * a diff read against text that has since moved, with Approve live. So
   * `pathsChangedBetween` runs without rename detection (a rename on the
   * TARGET reports the path it left as well as the one it arrived at), and
   * the request's own side contributes each file's `previousPath` alongside
   * its `path`.
   *
   * Answers true without asking git in the two cases where nothing may be
   * assumed: no fork point (the branches share no history, so there is no
   * range to diff) and a failed diff (an infra error must not read as "this
   * request is fine"). Answers false without asking git when the request is
   * not behind at all, or changes no files — the common case, and the one
   * that must stay free.
   */
  private async targetTouchesRequestFiles(
    workspaceId: string,
    forkPoint: { mergeBaseSha: string | null; behind: boolean },
    baseSha: string,
    files: PullRequestFile[],
  ): Promise<boolean> {
    if (!forkPoint.behind) return false;
    if (files.length === 0) return false;
    // Diverged with no common ancestor: the target's whole history is
    // "changed since the fork point", so anything this request touches is
    // touched. Nothing to intersect against, and nothing to skip for.
    if (!forkPoint.mergeBaseSha) return true;
    const requestPaths = new Set<string>();
    for (const f of files) {
      requestPaths.add(f.path);
      if (f.previousPath) requestPaths.add(f.previousPath);
    }
    try {
      const onTarget = await this.gitService.pathsChangedBetween(
        workspaceId,
        forkPoint.mergeBaseSha,
        // The target tip the WHOLE detail is pinned to, so this range ends
        // exactly where `behind` and the file list were computed.
        baseSha,
      );
      return onTarget.some((path) => requestPaths.has(path));
    } catch (err) {
      log.warn(
        'could not compare the target against a change request\'s files; treating it as needing an update',
        { err },
      );
      return true;
    }
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
    /** Did the target change, since the fork point, a file this request changes? */
    let targetChangedShared = false;
    // The SAME routing the list takes, from the same function, so the two
    // surfaces cannot disagree about which files a request has — see
    // {@link changeSourceFor} for why each state reads from what it does.
    const source = workspaceId ? changeSourceFor(row) : ({ kind: 'none' } as ChangeSource);
    try {
      if (workspaceId && source.kind === 'commit') {
        // An APPLIED request is read from its merge commit, not from its
        // branches: the source branch is retired, so there is nothing to resolve
        // and nothing to fetch. The commit's first parent is the target as it
        // stood before the merge and its second is the source tip that landed,
        // so the file list is exactly what was applied, and the `headSha` the
        // approvals are judged stale against is the head they were given on.
        //
        // Before the 2026-10-02 decision this fell into the catch below and
        // answered no files — which, since an empty file set proves no read
        // access, made every applied request readable by its author alone.
        // Reading back what happened is what the ticket exists for.
        const ends = await this.gitService.appliedChangeShas(workspaceId, source.applied);
        baseSha = ends.baseSha;
        headSha = ends.headSha;
        files = await this.gitService.changedFilesOfAppliedChange(workspaceId, source.applied, {
          ...(opts.patches === false ? { patchCap: 0 } : {}),
        });
        // `forkPoint` and `targetChangedShared` stay at their defaults. "Is this
        // behind its target, and does the divergence reach its files" is a
        // question about a proposal that could still be updated; an applied one
        // has no answer to give and reports none (`behind` and `needsUpdate` are
        // gated on `state === 'open'` downstream anyway).
      } else if (workspaceId && source.kind === 'branches') {
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
        // Only a target that moved in a file THIS request also changes makes the
        // proposal's diff describe text that has moved. One extra
        // `diff --name-only` (and only when the branches have diverged at all)
        // buys the difference between opening instantly and paying for a merge,
        // a push and a second detail read.
        targetChangedShared = await this.targetTouchesRequestFiles(
          workspaceId,
          forkPoint,
          baseSha,
          files,
        );
      }
      // `source.kind === 'none'` — a DECLINED request, a merged row recording no
      // merge commit, or no workspace at all — asks git NOTHING and is answered
      // from the ROW ALONE: no shas, no files. The row's STATE decides that, not
      // whether git happens to fail, which is the fix for the contradiction
      // Local Testing found: declining does not retire the source branch (only
      // merging deletes it), so the branch pair below resolved a declined
      // request perfectly well and published its files to anyone who could read
      // one of them — while the list, which gives a declined row no paths at
      // all, hid the same request from the same caller.
    } catch (err) {
      // What reaches this is a MERGED request whose merge commit this clone
      // cannot resolve — not fetched yet, or a sha the row records that the
      // object store does not hold. A DECLINED request never gets here at all
      // any more: it asks git nothing (see above), so it cannot fail.
      //
      // Everything the ROW records — title, body, state, author, times — is
      // still true, and this is the degradation the no-workspace case above
      // already takes: no shas and no files, rather than no answer at all. Since
      // an empty file set proves no read access, such a row fails CLOSED to its
      // author, and the next read, once the commit is in the clone, answers in
      // full.
      //
      // An OPEN request still fails loudly. There, an unresolvable branch means
      // a branch not yet published or a clone not yet caught up, and presenting
      // a live proposal as one that changes nothing would tell a reviewer the
      // opposite of the truth.
      if (!(err instanceof WorkflowValidationError) || row.state === 'open') throw err;
      log.warn(
        `change request #${prNumber} is ${row.state} and can no longer be diffed; answering from its row alone:`,
        { err },
      );
      baseSha = '';
      headSha = '';
      files = [];
      forkPoint = { mergeBaseSha: null, behind: false };
      targetChangedShared = false;
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

    // The detail has the real file list, so its pairs come straight off it —
    // the same shape the list builds from its own diff, so a reader gating on
    // `touchedNodeFiles` gets the same verdict from a summary and a detail.
    const summary = this.rowToSummary(
      row,
      files.map((f) => f.path),
      files.map((f) => ({
        path: f.path,
        ...(f.previousPath ? { previousPath: f.previousPath } : {}),
      })),
    );

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

    // Hashed here, not on the client: the detail carries an author HASH and no
    // author email, so the comparison can only happen where the viewer's email
    // is already known.
    const viewerIsAuthor = !!(
      opts.viewerEmail &&
      summary.authorId &&
      summary.authorId === hashEmail(opts.viewerEmail)
    );

    const viewerCanDelete = computeViewerCanDelete({
      state: summary.state,
      authorId: summary.authorId,
      viewerEmail: opts.viewerEmail,
      viewerCanBypassMerge,
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
      // `behind` AND the divergence actually reaches this request's files.
      // Both halves, in this order, so a closed request is never either.
      needsUpdate: summary.state === 'open' && forkPoint.behind && targetChangedShared,
      viewerCanUpdate,
      viewerIsAuthor,
      viewerCanDelete,
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

/**
 * Pure predicate for the `viewerCanDelete` hint — who may delete a request
 * outright, closing it AND retiring its branch. The author (their own
 * proposal and their own branch) or an admin (`viewerCanBypassMerge` is the
 * proxy — the same `canWriteAtRef('roles.yaml')` predicate the DELETE route
 * enforces). Mirrors `deleteChangeRequest` exactly, which is why it differs
 * from its two siblings in both directions:
 *
 * - It does NOT grant the owner of every changed file, as
 *   `computeViewerCanCancel` does. Declining someone else's request leaves
 *   their branch to rework; deleting it destroys their text.
 * - It bars only `merged`, not everything that is not `open`. A request
 *   withdrawn in another tab is `closed` and still has a leftover branch the
 *   server will retire, so the button must survive it. Applied history is
 *   nobody's to delete.
 *
 * Fail-closed: no viewer email → false, whatever the grants say.
 */
export function computeViewerCanDelete(input: {
  state: PullRequestState;
  authorId: string | undefined;
  viewerEmail: string | undefined;
  viewerCanBypassMerge: boolean;
}): boolean {
  if (input.state === 'merged') return false;
  if (!input.viewerEmail) return false;
  const viewerIsAuthor = !!(input.authorId && input.authorId === hashEmail(input.viewerEmail));
  return viewerIsAuthor || input.viewerCanBypassMerge;
}

export const __testing = {
  computeViewerCanCancel,
  computeViewerCanUpdate,
  computeViewerCanDelete,
};
