/**
 * The mapping from Hexis's change-request types to the shapes the five agent
 * read tools answer in.
 *
 * The tools are named and shaped after GitHub's pull-request API — one tool per
 * GitHub endpoint, the same filters, the same paging — but they SPEAK HEXIS
 * (decision by Razvan, 2026-10-02, on the review of PR #347). An agent opens a
 * change request with `open_change_request` and reads it back with these five;
 * answering the first in Hexis's words and the second in GitHub's would make
 * one request two vocabularies. So every field these answers share with
 * `open_change_request`'s summary takes that summary's name — `url`, `number`,
 * `title`, `state`, `sourceBranch`, `targetBranch`, `approvals`,
 * `mergeBlockedReasons`, `files[].path`, `files[].change` — and the rest follow
 * the same style (camelCase, Hexis's own words for Hexis's own facts).
 *
 * What that changed, against GitHub, and why each is the better answer here:
 *
 *   - **State is Hexis's own.** GitHub has two states and a `merged` flag;
 *     Hexis has three — `open`, `merged`, `closed` — and reports them. A merged
 *     request is `state: "merged"`, not `closed` with `merged: true`: the flag
 *     exists on GitHub only because its model has nowhere else to put the fact,
 *     and an agent reading `state` should not have to read a second field to
 *     learn whether the change landed.
 *   - **One name per path.** GitHub names a pull-request file's path `filename`
 *     and a review comment's `path`; mirroring that inconsistency was the point
 *     while these tools wore GitHub's names, and is now just a trap. Every path
 *     in every answer is `path`, and a moved file's old name is `previousPath`,
 *     as `open_change_request` names them.
 *   - **A file's kind of change** is `change` — `added` / `changed` / `deleted`
 *     / `moved`, from the very function `open_change_request` uses
 *     ({@link changeKindOf}), not git's seven-way `status`. One request, one
 *     spelling of what happened to a file.
 *   - **Approvals are per FILE**, not per review submission, because that is
 *     what Hexis records. A reviewer's approvals at one staleness are gathered
 *     into one entry naming the files, which is as close to a GitHub review as
 *     Hexis's model honestly gets.
 *   - **`stale`, not `DISMISSED`.** Hexis's word for an approval a later push
 *     invalidated is `isStale`; a review entry reports `stale: true` rather
 *     than borrowing GitHub's review state.
 *   - **A reply names its parent `parentId`**, which is the argument
 *     `post_change_request_comment` takes to create one. Reading a comment and
 *     replying to it use the same word for the same thing.
 *
 * The tools' INPUTS are untouched and stay GitHub's (`state`, `head`, `base`,
 * `author`, `per_page`, `page`, `include`): the ticket pins them by name, and
 * they are the one part of the surface where matching GitHub's spelling helps —
 * an agent that knows GitHub's list filters can use these without reading the
 * schema. Only the ANSWERS are Hexis's.
 *
 * Pure, and deliberately so: every judgement these tools make about what a
 * caller may see is either an access lookup (which belongs to the service) or
 * one of the functions below (which belongs to a test that can read it). The
 * tools file does the IO and calls in here for every decision.
 */

import type {
  ChangeRequest,
  ChangeRequestComment,
  ChangeRequestDetail,
  ChangeRequestState,
  ChangedFile,
  FileApproval,
} from '@bevel-software/platform-shared';
import { canonicalEmail, hashEmail } from '../../../shared/email-identity.js';
import { changeKindOf, type ChangeKind } from './change-request-summary.js';

/** A person on a change request, a review or a comment. */
export interface CrUser {
  /** Hexis's author login — `user-<first 12 of the email hash>`, no raw email. */
  login: string;
  /** Display name, when Hexis knows one. */
  name?: string;
  /**
   * The person's address, for a comment author and an approver — the two
   * places the app's own change-request surfaces already show it, and what an
   * agent needs to address a reply to a reviewer. Never set on a change
   * request's `author`, which carries a hash-derived login only.
   */
  email?: string;
}

/**
 * A change request as a LIST row.
 *
 * `url` first, for the reason `open_change_request` puts it first: it is the
 * one field an agent must be able to hand a person, so it survives a truncation
 * of anything after it.
 */
export interface CrSummary {
  url: string;
  /** Present only when `url` is relative — how to get absolute links. */
  urlNote?: string;
  number: number;
  title: string;
  /** Hexis's own three states. A merged request says so; there is no flag. */
  state: ChangeRequestState;
  author: CrUser;
  sourceBranch: string;
  targetBranch: string;
  createdAt: string;
  updatedAt: string;
  /** How many of this request's files the CALLER may read. */
  changedFiles: number;
  /** How many it may not. Never named. */
  withheldFiles: number;
}

/** A change request read by number: the row, its description, and the gate. */
export interface CrDetail extends CrSummary {
  body: string;
  /** The source tip the answer describes. Absent when no ref could be resolved. */
  headSha?: string;
  /** The target tip it is read against. Absent when no ref could be resolved. */
  baseSha?: string;
  /**
   * Whether Hexis's merge gate would let this be applied — which, unlike
   * GitHub's `mergeable`, also waits on the per-file approvals. Kept beside the
   * blockers because a filtered `mergeBlockedReasons` can be empty while the
   * gate is still shut: see {@link visibleBlockers}.
   */
  mergeable: boolean;
  /**
   * Why it cannot be applied yet, in the gate's own words — the detail's list,
   * minus any line naming a file the caller may not read.
   */
  mergeBlockedReasons: string[];
  /** How many blockers were withheld because they name a withheld file. */
  withheldMergeBlockedReasons: number;
  /** What this caller, specifically, may do with the request. */
  viewer: CrViewer;
}

/** What the caller may do — Hexis's own facts, under Hexis's own names. */
export interface CrViewer {
  /** Whether the caller may approve at least one file they are shown. */
  mayApprove: boolean;
  /** Whether the caller's Apply would be accepted right now. */
  mayMerge: boolean;
  /** Whether the caller opened this request (their agent counts as them). */
  isAuthor: boolean;
}

export interface CrFile {
  path: string;
  /** Where a `moved` file came from. */
  previousPath?: string;
  /** `added` | `changed` | `deleted` | `moved` — `open_change_request`'s four. */
  change: ChangeKind;
  additions: number;
  deletions: number;
  /** Blob sha at the request head. */
  sha: string;
  /** Unified diff. Only on `include: ["patches"]`, and absent for binaries. */
  patch?: string;
  isBinary: boolean;
  /** Who must approve this file for the request to be applied. */
  requiredApprovers: { roles: string[]; users: CrUser[] };
  /**
   * Present when the approver set could not be resolved — then an empty
   * `requiredApprovers` means "not known", NOT "nobody has to approve". Same
   * name and same fail-closed reading as `open_change_request`'s.
   */
  approversUnknown?: true;
  /** Who has approved this file, and when. */
  approvedBy: CrFileApproval[];
  /** Whether a current approval by an eligible approver stands. */
  approved: boolean;
  /** Whether the merge gate waits on this file at all. */
  inMergeGate: boolean;
  /** Whether the caller may approve this file. */
  viewerMayApprove: boolean;
}

export interface CrFileApproval {
  user: CrUser;
  approvedAt: string;
  /** True when the approval was given against a head that has since moved. */
  stale: boolean;
  /** True when the approver is the request's own author. */
  selfApproval: boolean;
}

export interface CrReview {
  /** Stable within the request: the reviewer, and whether their approvals stand. */
  id: string;
  reviewer: CrUser;
  /** True once a later push invalidated the approvals gathered here. */
  stale: boolean;
  /** The most recent of the approvals gathered into this entry. */
  submittedAt: string;
  /** The files this reviewer approved — the readable ones. */
  files: string[];
  /** How many further files of this review the caller may not read. */
  withheldFiles: number;
}

export interface CrComment {
  id: string;
  author: CrUser;
  body: string;
  /** Set on a file-level or inline comment. */
  path?: string;
  /** Set on an inline comment. */
  line?: number;
  /**
   * The comment this one replies to — the same `parentId`
   * `post_change_request_comment` takes to post the reply.
   */
  parentId?: string;
  /** The head the comment was anchored to. */
  headSha: string;
  createdAt: string;
  /** Present once edited. */
  updatedAt?: string;
}

/** One page of a list, and whether there is another. */
export interface CrPage<T> {
  items: T[];
  totalCount: number;
  page: number;
  perPage: number;
  hasNextPage: boolean;
}

export const PER_PAGE_DEFAULT = 30;
export const PER_PAGE_MAX = 100;

/**
 * GitHub's `per_page` (default 30, at most 100) and `page` (from 1), read off
 * whatever the caller sent. A value out of range is clamped rather than
 * refused, because a tool call that asks for 500 wants as many as it can have.
 */
export function pagingOf(args: { per_page?: unknown; page?: unknown }): {
  perPage: number;
  page: number;
} {
  const rawPer = typeof args.per_page === 'number' ? Math.trunc(args.per_page) : PER_PAGE_DEFAULT;
  const rawPage = typeof args.page === 'number' ? Math.trunc(args.page) : 1;
  return {
    perPage: Math.min(PER_PAGE_MAX, Math.max(1, Number.isFinite(rawPer) ? rawPer : PER_PAGE_DEFAULT)),
    page: Math.max(1, Number.isFinite(rawPage) ? rawPage : 1),
  };
}

/**
 * One page out of an already-filtered list. Paging runs AFTER the access
 * filter, always: a page sliced before it would say by its own short length
 * how many entries were withheld, which is the count's job to say and nobody
 * else's.
 */
export function pageOf<T>(all: T[], perPage: number, page: number): CrPage<T> {
  const start = (page - 1) * perPage;
  return {
    items: all.slice(start, start + perPage),
    totalCount: all.length,
    page,
    perPage,
    hasNextPage: start + perPage < all.length,
  };
}

/**
 * The Hexis states the `state` FILTER selects. The filter keeps GitHub's three
 * words because the ticket names them, and `closed` there means "not open" —
 * which over Hexis's states is `closed` (declined) and `merged` alike. The
 * ANSWER still reports which of the two a request is.
 */
export function statesFor(filter: 'open' | 'closed' | 'all'): ChangeRequestState[] {
  if (filter === 'open') return ['open'];
  if (filter === 'closed') return ['closed', 'merged'];
  return ['open', 'closed', 'merged'];
}

/** The request's author: a hash-derived login, never an email. */
export function crAuthor(cr: Pick<ChangeRequest, 'author' | 'appAuthor'>): CrUser {
  const name = cr.appAuthor?.name ?? cr.author.name;
  return { login: cr.author.login, ...(name ? { name } : {}) };
}

/**
 * Whether `needle` names this request's author — an email (compared as the
 * author hash, since the request stores no raw address) or a login. Mirrors
 * `listPrsAuthoredBy`, so the tool's `author` filter and the app's "mine" list
 * agree on who wrote what.
 */
export function matchesAuthor(
  cr: Pick<ChangeRequest, 'author' | 'authorId'>,
  needle: string,
): boolean {
  const wanted = canonicalEmail(needle);
  if (!wanted) return false;
  if (wanted.includes('@')) return !!(cr.authorId && cr.authorId === hashEmail(wanted));
  return cr.author.login.toLowerCase() === wanted;
}

/** Whether `viewerEmail` opened this request. */
export function isAuthor(
  cr: Pick<ChangeRequest, 'authorId'>,
  viewerEmail: string | undefined,
): boolean {
  return !!(viewerEmail && cr.authorId && cr.authorId === hashEmail(viewerEmail));
}

/**
 * Whether the caller may SEE a change request at all.
 *
 * Readable files, or authorship. Nothing else: a request every file of which
 * is closed to the caller tells them, by existing, that somebody proposed a
 * change to something they may not look at, and requirement 7 answers that
 * with a 404 rather than an empty shell.
 *
 * A request with NO files resolved is not visible to a non-author either, and
 * that is deliberate rather than an oversight: an empty file set is what both a
 * request that genuinely changes nothing and a request whose diff could not be
 * computed look like, and the two are indistinguishable from here. So an empty
 * set proves no read access — the same rule `scopeApplyFailures` applies to the
 * same question on the same lists.
 *
 * Since the 2026-10-02 decision this is a far smaller class than it was: a
 * MERGED request's files are recovered from its merge commit, so being applied
 * no longer hides a request from everyone but its author. What is left is a
 * DECLINED request (no merge commit was ever written, and its branch is gone)
 * and a clone that cannot resolve the commit at all.
 */
export function maySeeChangeRequest(input: {
  readableFiles: number;
  isAuthor: boolean;
}): boolean {
  return input.isAuthor || input.readableFiles > 0;
}

/** A list row. `readable` / `withheld` come from the access filter. */
export function toCrSummary(
  cr: ChangeRequest,
  counts: { readable: number; withheld: number },
): CrSummary {
  return {
    url: cr.url,
    ...(cr.urlNote ? { urlNote: cr.urlNote } : {}),
    number: cr.number,
    title: cr.title,
    state: cr.state,
    author: crAuthor(cr),
    sourceBranch: cr.branch,
    targetBranch: cr.base,
    createdAt: cr.createdAt,
    updatedAt: cr.updatedAt ?? cr.createdAt,
    changedFiles: counts.readable,
    withheldFiles: counts.withheld,
  };
}

/** A detail: the row, the author's description, and the gate as this caller sees it. */
export function toCrDetail(
  detail: ChangeRequestDetail,
  counts: { readable: number; withheld: number },
  blockers: { visible: string[]; withheld: number },
  viewer: CrViewer,
): CrDetail {
  return {
    ...toCrSummary(detail, counts),
    // Empty rather than present-and-empty: a merged request read from its merge
    // commit knows both commits, a declined one knows neither, and `''` would
    // read as a sha nobody can look up.
    ...(detail.headSha ? { headSha: detail.headSha } : {}),
    ...(detail.baseSha ? { baseSha: detail.baseSha } : {}),
    body: authorsDescription(detail.body),
    mergeable: detail.mergeableInBevel,
    mergeBlockedReasons: blockers.visible,
    withheldMergeBlockedReasons: blockers.withheld,
    viewer,
  };
}

/**
 * The part of a change-request body its AUTHOR wrote.
 *
 * A Hexis body is part human and part machine: `openChangeRequest` appends an
 * `## Affected owners` block — one line per changed path, naming that path and
 * its eligible approvers — to whatever the author typed. Returning the body
 * verbatim NAMED every file of the request, including the ones this caller may
 * not read: Local Testing caught a GTM-team reader being handed
 * `- \`KnowledgeBase/Engineering/…\` — Admin` out of a request whose file list
 * had correctly withheld that very path.
 *
 * So the generated block goes, and NOTHING ELSE does. The first cut at this
 * copied the app's dialog, which drops everything from the first `##` heading
 * on; Razvan's review (2026-10-02) asked for the narrower cut, because an
 * author who writes their description in sections loses it from that heading
 * onwards and is never told. The generated block is appended LAST and begins
 * with a line that is exactly `## Affected owners`, so cutting at the LAST such
 * line removes the machinery and keeps every heading a person wrote. (An author
 * who writes that exact heading themselves loses their text from there — the
 * safe direction, and the only way this can err.)
 *
 * HTML comments go too: older bodies carry hidden identity markers.
 *
 * Who must approve each file is NOT lost by this — it is what
 * `list_change_request_files` answers under `requiredApprovers`, per file and
 * access-filtered, which is where a caller should read it from anyway.
 *
 * Two things this deliberately does not do. It does not vary by caller: one
 * body for everyone is a body nobody has to reason about. And it does not touch
 * the author's own prose, which may mention any path they chose to write about —
 * that is a person's sentence, shown to every viewer in the app, not Hexis
 * naming a file it was asked to withhold.
 */
export function authorsDescription(body: string): string {
  const lines = body.split('\n');
  const generated = lines.lastIndexOf('## Affected owners');
  return (generated === -1 ? lines : lines.slice(0, generated))
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

/**
 * What this caller may do with the request.
 *
 * `mayMerge` reproduces what `mergePr` would accept, from the detail's own
 * published fields: no hard block, and either nothing missing or an admin who
 * may bypass what is. Deriving it here rather than asking a second time keeps
 * the answer and the enforcement reading the same gate.
 *
 * `mayApprove` answers over `shownApprovals` — the approvals of the files this
 * caller is SHOWN — and not over the request's whole approval set, which is why
 * the set is passed in rather than read off `detail`. The two differ:
 * `viewerCanApprove` is a WRITE grant at `origin/<base>`, and a write grant can
 * hold for a file whose read verdict withholds it. Answering true off such a
 * file would both contradict the contract ("at least one file they are shown")
 * and tell the caller something about a file they were refused.
 */
export function toCrViewer(
  detail: Pick<
    ChangeRequestDetail,
    'state' | 'mergeBlockedReasons' | 'mergeWarnings' | 'viewerCanBypassMerge'
  >,
  viewerIsAuthor: boolean,
  shownApprovals: Pick<FileApproval, 'viewerCanApprove'>[],
): CrViewer {
  const warnings = new Set(detail.mergeWarnings);
  const hard = detail.mergeBlockedReasons.filter((r) => !warnings.has(r));
  return {
    mayApprove: shownApprovals.some((a) => a.viewerCanApprove),
    mayMerge:
      detail.state === 'open' &&
      hard.length === 0 &&
      (detail.mergeWarnings.length === 0 || detail.viewerCanBypassMerge),
    isAuthor: viewerIsAuthor,
  };
}

/**
 * The merge blockers the caller may read.
 *
 * A gate warning quotes the path it waits on (`Waiting on approval for
 * X from …`), so a blocker about a withheld file would name that file. Each
 * blocker mentioning any withheld path is dropped and counted. Matching on the
 * text rather than rebuilding the gate's sentences is deliberate: the gate owns
 * its wording, and the only way this can err is by withholding a line that
 * contains a withheld path as a substring — which is the safe direction.
 */
export function visibleBlockers(
  reasons: string[],
  withheldPaths: string[],
): { visible: string[]; withheld: number } {
  if (withheldPaths.length === 0) return { visible: [...reasons], withheld: 0 };
  const visible = reasons.filter((r) => !withheldPaths.some((p) => r.includes(p)));
  return { visible, withheld: reasons.length - visible.length };
}

/**
 * Whether the caller may read a changed file AT ALL.
 *
 * Both of its names must be readable. A moved file carries its old path in
 * `previousPath`, and the diff of a move shows the content that was at that
 * old path — so a file moved OUT of a folder the caller may not read is not
 * readable here either, however open its new home is, and `previousPath` can
 * never name a path they were refused. Fail-closed in the one direction that
 * matters: a file with nowhere to hide is listed, a file with a hidden side is
 * withheld and counted.
 */
export function fileIsReadable(
  file: Pick<ChangedFile, 'path' | 'previousPath'>,
  mayRead: (path: string) => boolean,
): boolean {
  if (!mayRead(file.path)) return false;
  return file.previousPath === undefined || mayRead(file.previousPath);
}

/** Every path a changed file names — both sides of a move. */
export function pathsOf(file: Pick<ChangedFile, 'path' | 'previousPath'>): string[] {
  return file.previousPath === undefined ? [file.path] : [file.path, file.previousPath];
}

/** A changed file plus its approval state. */
export function toCrFile(
  file: ChangedFile,
  approval: FileApproval | undefined,
  opts: { patches: boolean },
): CrFile {
  return {
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
    change: changeKindOf(file.status),
    additions: file.additions,
    deletions: file.deletions,
    sha: file.sha,
    ...(opts.patches && file.patch !== undefined ? { patch: file.patch } : {}),
    isBinary: file.isBinary,
    requiredApprovers: {
      roles: approval?.eligibleApprovers.roles ?? [],
      users: (approval?.eligibleApprovers.users ?? []).map((u) => ({
        login: loginFor(u.email),
        name: u.name,
        email: u.email,
      })),
    },
    // No approval entry at all means the lookup never ran (no workspace, an
    // unwired enricher), which is exactly the "unknown" the flag reports — and
    // it is reported the way `open_change_request` reports it: a present
    // `approversUnknown`, absent when the set IS known, so the fail-closed
    // reading is the one a caller gets by default.
    ...(approval?.eligibilityResolved === true ? {} : { approversUnknown: true as const }),
    approvedBy: (approval?.approvedBy ?? []).map(toCrFileApproval),
    approved: approval?.isApproved === true,
    inMergeGate: approval?.inMergeGate === true,
    viewerMayApprove: approval?.viewerCanApprove === true,
  };
}

function toCrFileApproval(entry: FileApproval['approvedBy'][number]): CrFileApproval {
  return {
    user: { login: loginFor(entry.email), name: entry.name, email: entry.email },
    approvedAt: entry.approvedAt,
    stale: entry.isStale,
    selfApproval: entry.isSelfApproval,
  };
}

/** The same hash-derived login the change-request summaries carry. */
export function loginFor(email: string): string {
  return `user-${hashEmail(email).slice(0, 12)}`;
}

/**
 * The reviews of a change request, gathered out of its per-file approvals.
 *
 * Hexis records an approval per FILE; a review list wants one entry per review.
 * One entry per (reviewer, staleness) is the closest honest join: it names the
 * reviewer once and the files they approved, which is what the ticket's
 * scenario asks to read back. A reviewer holding both a current and a stale
 * approval appears twice — one entry for the files that still stand and one
 * with `stale: true` for the ones the latest push invalidated.
 *
 * `mayShow` decides, per file, what this caller may be told. A review keeps the
 * files they may read and counts the rest in its own `withheldFiles`; a review
 * EVERY file of which is withheld is dropped and counted in `withheldReviews`,
 * because naming the reviewer would itself say that somebody approved a change
 * to something the caller may not look at. `submittedAt` is taken from the
 * readable approvals alone, for the same reason.
 *
 * Hexis records nothing about who DECLINED a request — a rejection closes it
 * and stores no reviewer — so no review entry can report one. A reviewer's
 * objection lives in a comment, which `list_change_request_comments` returns.
 */
export function toCrReviews(
  approvals: FileApproval[],
  mayShow: (path: string) => boolean = () => true,
): { reviews: CrReview[]; withheldReviews: number } {
  const byReviewer = new Map<string, CrReview>();
  for (const approval of approvals) {
    const readable = mayShow(approval.path);
    for (const entry of approval.approvedBy) {
      const login = loginFor(entry.email);
      const id = `${login}:${entry.isStale ? 'stale' : 'current'}`;
      let review = byReviewer.get(id);
      if (!review) {
        review = {
          id,
          reviewer: { login, name: entry.name, email: entry.email },
          stale: entry.isStale,
          submittedAt: '',
          files: [],
          withheldFiles: 0,
        };
        byReviewer.set(id, review);
      }
      if (!readable) {
        review.withheldFiles += 1;
        continue;
      }
      review.files.push(approval.path);
      if (entry.approvedAt > review.submittedAt) review.submittedAt = entry.approvedAt;
    }
  }
  const all = [...byReviewer.values()];
  const reviews = all.filter((r) => r.files.length > 0);
  return {
    reviews: reviews.sort(
      (a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id),
    ),
    withheldReviews: all.length - reviews.length,
  };
}

/** A comment. Covers the file-anchored and the general ones — Hexis has one table. */
export function toCrComment(comment: ChangeRequestComment): CrComment {
  return {
    id: comment.id,
    author: {
      login: loginFor(comment.author.email),
      name: comment.author.name,
      email: comment.author.email,
    },
    body: comment.body,
    ...(comment.path ? { path: comment.path } : {}),
    ...(comment.line !== undefined ? { line: comment.line } : {}),
    ...(comment.parentId ? { parentId: comment.parentId } : {}),
    headSha: comment.headSha,
    createdAt: comment.createdAt,
    ...(comment.updatedAt ? { updatedAt: comment.updatedAt } : {}),
  };
}

/**
 * The comments the caller may read, replies included in the answer only when
 * the comment they reply to is.
 *
 * A comment with no path is about the request as a whole, and a comment with
 * one is as readable as that path is NAMEABLE here (`mayShow`, so a comment
 * anchored to the new name of a file withheld for its old one goes with the
 * file rather than announcing it). A REPLY is neither, quite: it carries no
 * path of its own when it was posted without one, so judged on itself it is a
 * general comment — and `post_change_request_comment` takes `parentId` without
 * requiring `path`, so a reply to a comment on a withheld file was returned
 * with its body and a `parentId` naming a comment the caller cannot see.
 * Razvan's review (2026-10-02) asked for the rule the ticket states: a reply is
 * shown only when its parent is.
 *
 * So a comment is visible when its OWN path may be shown (if it has one) AND
 * its parent is visible, all the way up the chain. Both halves are needed:
 * inheriting only would show a reply naming a withheld file under a readable
 * parent, and checking only its own path would show it under a withheld one.
 *
 * Fail-closed at the edges. A `parentId` naming a comment that is not in this
 * request's list (deleted, or from somewhere this answer cannot see) is not
 * provably pathless, so the reply goes. A cycle — which the schema does not
 * permit and a corrupted row could still hold — is unresolvable, so it goes
 * too. Both are counted in the withheld total, never named.
 */
export function visibleComments<T extends { id: string; path?: string; parentId?: string }>(
  comments: T[],
  mayShow: (path: string) => boolean,
): { visible: T[]; withheld: number } {
  const byId = new Map(comments.map((c) => [c.id, c]));
  /** Memoised per id, so a long thread costs one walk and not one per reply. */
  const verdicts = new Map<string, boolean>();
  const mayShowComment = (comment: T, seen: Set<string>): boolean => {
    const cached = verdicts.get(comment.id);
    if (cached !== undefined) return cached;
    if (seen.has(comment.id)) return false;
    seen.add(comment.id);
    let verdict = !comment.path || mayShow(comment.path);
    if (verdict && comment.parentId) {
      const parent = byId.get(comment.parentId);
      verdict = parent !== undefined && mayShowComment(parent, seen);
    }
    verdicts.set(comment.id, verdict);
    return verdict;
  };
  const visible = comments.filter((c) => mayShowComment(c, new Set()));
  return { visible, withheld: comments.length - visible.length };
}
