/**
 * The mapping from Hexis's change-request types to the shapes the agent read
 * tools answer in — GitHub's pull-request API shapes, field for field where
 * GitHub has a counterpart.
 *
 * Pure, and deliberately so: every judgement these tools make about what a
 * caller may see is either an access lookup (which belongs to the service) or
 * one of the functions below (which belongs to a test that can read it). The
 * tools file does the IO and calls in here for every decision.
 *
 * Where GitHub and Hexis differ:
 *
 *   - **State.** GitHub has two states and a `merged` flag; Hexis has three
 *     (`open` / `merged` / `closed`). A merged request answers `state: closed`
 *     with `merged: true`, which is GitHub's convention (decision 1 on the
 *     ticket), and a rejected or withdrawn one `state: closed` with
 *     `merged: false`.
 *   - **`mergeable`.** On GitHub this is git's answer (would the merge
 *     conflict). Hexis's nearest fact is its own merge gate, which also waits
 *     on the per-file approvals — so `mergeable` is that gate's verdict, and
 *     `access.merge_blockers` says what it is waiting for.
 *   - **Files name their path `filename`**, as GitHub's "list pull request
 *     files" does, while a review comment names its path `path`, as GitHub's
 *     "list review comments" does. The inconsistency is GitHub's; mirroring it
 *     is the point.
 *   - **Approvals are per FILE**, not per review submission. A reviewer's
 *     approvals at one state are gathered into one review entry naming the
 *     files, which is as close to a GitHub review as Hexis's model gets.
 *
 * What Hexis has beyond GitHub rides under its OWN names (`required_approvers`,
 * `approved_by`, `withheld_files`, `access`), never under a GitHub name with a
 * different meaning.
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

/** GitHub's two pull-request states. Hexis's `merged` folds into `closed`. */
export type GhState = 'open' | 'closed';

/** GitHub's `user` on a pull request, review or comment. */
export interface GhUser {
  /** Hexis's author login — `user-<first 12 of the email hash>`, no raw email. */
  login: string;
  /** Display name, when Hexis knows one. */
  name?: string;
  /**
   * The person's address, for a comment author and an approver — the two
   * places the app's own change-request surfaces already show it, and what an
   * agent needs to address a reply to a reviewer. Never set on a change
   * request's `user`, which carries a hash-derived login only.
   */
  email?: string;
}

/** GitHub's `head` / `base` on a pull request: a ref, plus its sha where known. */
export interface GhRef {
  ref: string;
  sha?: string;
}

export interface GhChangeRequest {
  number: number;
  state: GhState;
  title: string;
  user: GhUser;
  head: GhRef;
  base: GhRef;
  created_at: string;
  updated_at: string;
  merged: boolean;
  html_url: string;
  /** Present only when `html_url` is relative — how to get absolute links. */
  url_note?: string;
  /** GitHub's count. Hexis's twist: the files the CALLER may read. */
  changed_files: number;
  /** How many of this request's files the caller may not read. Never named. */
  withheld_files: number;
}

export interface GhChangeRequestDetail extends GhChangeRequest {
  body: string;
  mergeable: boolean;
  /** What Hexis knows that GitHub does not — see {@link GhAccess}. */
  access: GhAccess;
}

/** Hexis's own block on a change request: the gate, and what the caller may do. */
export interface GhAccess {
  /**
   * Why the request cannot be applied yet, in the gate's own words. A blocker
   * naming a file the caller may not read is withheld and counted below
   * instead — the words would otherwise name the path.
   */
  merge_blockers: string[];
  withheld_merge_blockers: number;
  /** Whether the caller may approve at least one file they can read. */
  may_approve: boolean;
  /** Whether the caller's Apply would be accepted right now. */
  may_merge: boolean;
  /** Whether the caller opened this request (their agent counts as them). */
  is_author: boolean;
}

export interface GhFile {
  /** GitHub names a pull-request file's path `filename`. */
  filename: string;
  /** GitHub's `previous_filename` — set for renames and copies. */
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
  /** Unified diff. Only on `include: ["patches"]`, and absent for binaries. */
  patch?: string;
  is_binary: boolean;
  /** Hexis: who must approve this file for the request to be applied. */
  required_approvers: { roles: string[]; users: GhUser[] };
  /**
   * Hexis: false when the approver set could not be resolved — an empty
   * `required_approvers` then means "unknown", not "nobody has to approve".
   */
  required_approvers_resolved: boolean;
  /** Hexis: who has approved this file, and when. */
  approved_by: GhApproval[];
  /** Hexis: whether a current approval by an eligible approver stands. */
  approved: boolean;
  /** Hexis: whether the merge gate waits on this file at all. */
  in_merge_gate: boolean;
  /** Hexis: whether the caller may approve this file. */
  viewer_may_approve: boolean;
}

export interface GhApproval {
  user: GhUser;
  approved_at: string;
  /** True when the approval was given against a head that has since moved. */
  stale: boolean;
  /** True when the approver is the request's own author. */
  self_approval: boolean;
}

export interface GhReview {
  /** Stable within the request: the reviewer and the state they are in. */
  id: string;
  user: GhUser;
  /** GitHub's review states, of which Hexis can produce these two. */
  state: 'APPROVED' | 'DISMISSED';
  /** The most recent of the approvals gathered into this review. */
  submitted_at: string;
  /** Hexis: the files this reviewer approved — the readable ones. */
  files: string[];
  /** Hexis: how many further files of this review the caller may not read. */
  withheld_files: number;
}

export interface GhComment {
  id: string;
  user: GhUser;
  body: string;
  /** Set on a file-level or inline comment. */
  path?: string;
  /** Set on an inline comment. */
  line?: number;
  /** The comment this one replies to, as the ticket names it. */
  in_reply_to?: string;
  /** GitHub's `commit_id` — the head the comment was anchored to. */
  commit_id: string;
  created_at: string;
  /** Present once edited. */
  updated_at?: string;
}

/** One page of a list, and whether there is another. */
export interface GhPage<T> {
  items: T[];
  total_count: number;
  page: number;
  per_page: number;
  has_next_page: boolean;
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
export function pageOf<T>(all: T[], perPage: number, page: number): GhPage<T> {
  const start = (page - 1) * perPage;
  return {
    items: all.slice(start, start + perPage),
    total_count: all.length,
    page,
    per_page: perPage,
    has_next_page: start + perPage < all.length,
  };
}

/** GitHub's `state` for a Hexis state: merged counts as closed. */
export function ghState(state: ChangeRequestState): GhState {
  return state === 'open' ? 'open' : 'closed';
}

/** GitHub's `merged` flag. */
export function ghMerged(state: ChangeRequestState): boolean {
  return state === 'merged';
}

/** The `state` filter's Hexis states. `closed` covers merged and rejected alike. */
export function statesFor(filter: 'open' | 'closed' | 'all'): ChangeRequestState[] {
  if (filter === 'open') return ['open'];
  if (filter === 'closed') return ['closed', 'merged'];
  return ['open', 'closed', 'merged'];
}

/** The request's author, GitHub-shaped: a hash-derived login, never an email. */
export function ghAuthor(cr: Pick<ChangeRequest, 'author' | 'appAuthor'>): GhUser {
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
 * that is deliberate rather than an oversight: `touchedNodePaths` is empty both
 * for a request that genuinely changes nothing and for one whose diff could not
 * be computed (no clone yet, a retired branch, a git failure). The two are
 * indistinguishable from here, so an empty set proves no read access — the same
 * rule `scopeApplyFailures` applies to the same question on the same lists.
 */
export function maySeeChangeRequest(input: {
  readableFiles: number;
  isAuthor: boolean;
}): boolean {
  return input.isAuthor || input.readableFiles > 0;
}

/** A summary, GitHub-shaped. `readable` / `withheld` come from the access filter. */
export function toGhChangeRequest(
  cr: ChangeRequest,
  counts: { readable: number; withheld: number },
): GhChangeRequest {
  return {
    number: cr.number,
    state: ghState(cr.state),
    title: cr.title,
    user: ghAuthor(cr),
    head: { ref: cr.branch },
    base: { ref: cr.base },
    created_at: cr.createdAt,
    updated_at: cr.updatedAt ?? cr.createdAt,
    merged: ghMerged(cr.state),
    html_url: cr.url,
    ...(cr.urlNote ? { url_note: cr.urlNote } : {}),
    changed_files: counts.readable,
    withheld_files: counts.withheld,
  };
}

/** A detail, GitHub-shaped, with Hexis's `access` block on top. */
export function toGhChangeRequestDetail(
  detail: ChangeRequestDetail,
  counts: { readable: number; withheld: number },
  access: GhAccess,
): GhChangeRequestDetail {
  return {
    ...toGhChangeRequest(detail, counts),
    head: { ref: detail.branch, sha: detail.headSha },
    base: { ref: detail.base, sha: detail.baseSha },
    body: authorsDescription(detail.body),
    mergeable: detail.mergeableInBevel,
    access,
  };
}

/**
 * The part of a change-request body its AUTHOR wrote.
 *
 * A Hexis body is part human and part machine: `openChangeRequest` appends an
 * `## Affected owners` block — one line per changed path, naming that path and
 * its eligible approvers — to whatever the author typed, and the propose flow
 * types nothing at all, so the body is usually pure machinery. Returning it
 * verbatim NAMED every file of the request, including the ones this caller may
 * not read: Local Testing caught a GTM-team reader being handed
 * `- \`KnowledgeBase/Engineering/…\` — Admin` out of a request whose file list
 * had correctly withheld that very path.
 *
 * So the rule here is the app's own, character for character: everything from
 * the first generated `##` heading on is dropped, and HTML comments (the hidden
 * identity markers older bodies carry) go with it. `authorsReason` in
 * `ChangeRequestDialog.tsx` has read a body this way all along — "a routing
 * table is not the reason someone wants this change" — so a person in the app
 * and an agent over MCP now see the same text, and GitHub's `body` means what
 * it means on GitHub: what the author wrote.
 *
 * Who must approve each file is NOT lost by this — it is what
 * `list_change_request_files` answers under `required_approvers`, per file and
 * access-filtered, which is where a caller should read it from anyway.
 *
 * Two things this deliberately does not do. It does not vary by caller: one
 * body for everyone is a body nobody has to reason about. And it does not touch
 * the author's own prose, which may mention any path they chose to write about —
 * that is a person's sentence, shown to every viewer in the app, not Hexis
 * naming a file it was asked to withhold.
 */
export function authorsDescription(body: string): string {
  return body
    .split(/^##\s+/m)[0]
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

/**
 * Hexis's `access` block.
 *
 * `may_merge` reproduces what `mergePr` would accept, from the detail's own
 * published fields: no hard block, and either nothing missing or an admin who
 * may bypass what is. Deriving it here rather than asking a second time keeps
 * the answer and the enforcement reading the same gate.
 *
 * `blockers` arrive already filtered — see {@link visibleBlockers}.
 */
export function toGhAccess(
  detail: Pick<
    ChangeRequestDetail,
    'state' | 'mergeBlockedReasons' | 'mergeWarnings' | 'viewerCanBypassMerge' | 'approvals'
  >,
  blockers: { visible: string[]; withheld: number },
  viewerIsAuthor: boolean,
): GhAccess {
  const warnings = new Set(detail.mergeWarnings);
  const hard = detail.mergeBlockedReasons.filter((r) => !warnings.has(r));
  return {
    merge_blockers: blockers.visible,
    withheld_merge_blockers: blockers.withheld,
    may_approve: detail.approvals.some((a) => a.viewerCanApprove),
    may_merge:
      detail.state === 'open' &&
      hard.length === 0 &&
      (detail.mergeWarnings.length === 0 || detail.viewerCanBypassMerge),
    is_author: viewerIsAuthor,
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
 * Both of its names must be readable. A rename carries its old path in
 * `previousPath`, and the diff of a rename shows the content that was at that
 * old path — so a file renamed OUT of a folder the caller may not read is not
 * readable here either, however open its new home is, and `previous_filename`
 * can never name a path they were refused. Fail-closed in the one direction
 * that matters: a file with nowhere to hide is listed, a file with a hidden
 * side is withheld and counted.
 */
export function fileIsReadable(
  file: Pick<ChangedFile, 'path' | 'previousPath'>,
  mayRead: (path: string) => boolean,
): boolean {
  if (!mayRead(file.path)) return false;
  return file.previousPath === undefined || mayRead(file.previousPath);
}

/** Every path a changed file names — both sides of a rename. */
export function pathsOf(file: Pick<ChangedFile, 'path' | 'previousPath'>): string[] {
  return file.previousPath === undefined ? [file.path] : [file.path, file.previousPath];
}

/** A changed file plus its approval state, GitHub-shaped. */
export function toGhFile(
  file: ChangedFile,
  approval: FileApproval | undefined,
  opts: { patches: boolean },
): GhFile {
  return {
    filename: file.path,
    ...(file.previousPath ? { previous_filename: file.previousPath } : {}),
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.additions + file.deletions,
    sha: file.sha,
    ...(opts.patches && file.patch !== undefined ? { patch: file.patch } : {}),
    is_binary: file.isBinary,
    required_approvers: {
      roles: approval?.eligibleApprovers.roles ?? [],
      users: (approval?.eligibleApprovers.users ?? []).map((u) => ({
        login: loginFor(u.email),
        name: u.name,
        email: u.email,
      })),
    },
    // No approval entry at all means the lookup never ran (no workspace, an
    // unwired enricher), which is exactly the "unknown" the flag reports.
    required_approvers_resolved: approval?.eligibilityResolved === true,
    approved_by: (approval?.approvedBy ?? []).map(toGhApproval),
    approved: approval?.isApproved === true,
    in_merge_gate: approval?.inMergeGate === true,
    viewer_may_approve: approval?.viewerCanApprove === true,
  };
}

function toGhApproval(entry: FileApproval['approvedBy'][number]): GhApproval {
  return {
    user: { login: loginFor(entry.email), name: entry.name, email: entry.email },
    approved_at: entry.approvedAt,
    stale: entry.isStale,
    self_approval: entry.isSelfApproval,
  };
}

/** The same hash-derived login the change-request summaries carry. */
export function loginFor(email: string): string {
  return `user-${hashEmail(email).slice(0, 12)}`;
}

/**
 * The reviews of a change request, gathered out of its per-file approvals.
 *
 * Hexis records an approval per FILE; GitHub lists one entry per review
 * submission. One entry per (reviewer, state) is the closest honest join: it
 * names the reviewer once and the files they approved, which is what the
 * ticket's scenario asks to read back. A reviewer holding both a current and a
 * stale approval appears twice — `APPROVED` for the files that still stand and
 * `DISMISSED` for the ones the latest push invalidated, GitHub's own word for
 * a review that no longer counts.
 *
 * `mayRead` decides, per file, what this caller may be told. A review keeps the
 * files they may read and counts the rest in its own `withheld_files`; a review
 * EVERY file of which is withheld is dropped and counted in `withheldReviews`,
 * because naming the reviewer would itself say that somebody approved a change
 * to something the caller may not look at. `submitted_at` is taken from the
 * readable approvals alone, for the same reason.
 *
 * Hexis records nothing about who DECLINED a request — a rejection closes it
 * and stores no reviewer — so no review entry can report one. There is no
 * `CHANGES_REQUESTED` to answer with; a reviewer's objection lives in a
 * comment, which `list_change_request_comments` returns.
 */
export function toGhReviews(
  approvals: FileApproval[],
  mayRead: (path: string) => boolean = () => true,
): { reviews: GhReview[]; withheldReviews: number } {
  const byReviewer = new Map<string, GhReview>();
  for (const approval of approvals) {
    const readable = mayRead(approval.path);
    for (const entry of approval.approvedBy) {
      const state: GhReview['state'] = entry.isStale ? 'DISMISSED' : 'APPROVED';
      const login = loginFor(entry.email);
      const id = `${login}:${state}`;
      let review = byReviewer.get(id);
      if (!review) {
        review = {
          id,
          user: { login, name: entry.name, email: entry.email },
          state,
          submitted_at: '',
          files: [],
          withheld_files: 0,
        };
        byReviewer.set(id, review);
      }
      if (!readable) {
        review.withheld_files += 1;
        continue;
      }
      review.files.push(approval.path);
      if (entry.approvedAt > review.submitted_at) review.submitted_at = entry.approvedAt;
    }
  }
  const all = [...byReviewer.values()];
  const reviews = all.filter((r) => r.files.length > 0);
  return {
    reviews: reviews.sort(
      (a, b) => a.submitted_at.localeCompare(b.submitted_at) || a.id.localeCompare(b.id),
    ),
    withheldReviews: all.length - reviews.length,
  };
}

/** A review comment, GitHub-shaped. Covers the general ones too — Hexis has one table. */
export function toGhComment(comment: ChangeRequestComment): GhComment {
  return {
    id: comment.id,
    user: {
      login: loginFor(comment.author.email),
      name: comment.author.name,
      email: comment.author.email,
    },
    body: comment.body,
    ...(comment.path ? { path: comment.path } : {}),
    ...(comment.line !== undefined ? { line: comment.line } : {}),
    ...(comment.parentId ? { in_reply_to: comment.parentId } : {}),
    commit_id: comment.headSha,
    created_at: comment.createdAt,
    ...(comment.updatedAt ? { updated_at: comment.updatedAt } : {}),
  };
}
