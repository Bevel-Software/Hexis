import type {
  ChangeRequestDetail,
  ChangeRequestState,
  ChangedFile,
  FileApproval,
  PrFileStatus,
} from '@bevel-software/platform-shared';

/**
 * What `open_change_request` answers, and why it is not the detail the app's
 * dialog reads.
 *
 * The dialog renders every file's diff, so its detail carries every patch. An
 * agent that opens a change request needs none of that: it needs the link to
 * hand the user, and enough of the request to confirm it carries the files it
 * meant to propose and to say what the request is now waiting on. Handing it
 * the dialog's detail cost ~445,000 characters for 27 files of 15 KB — past
 * every tool-result limit, so the one field the agent actually needed (the
 * link) could not be read at all.
 *
 * So this is a purpose-made answer: the link first, the request's identity,
 * who must approve each path, what blocks the merge verbatim from the detail,
 * and the changed paths with their kind of change — no patch, no file content.
 * An agent that wants more asks for it by name through `include`.
 */

/** What `include` accepts. */
export type ChangeRequestInclude = 'patches' | 'all-paths';

/** The two `include` values, for the tool's input schema and its validation. */
export const CHANGE_REQUEST_INCLUDES: readonly ChangeRequestInclude[] = ['patches', 'all-paths'];

/** How many paths the answer lists before it cuts; `all-paths` lifts the cut. */
export const CHANGE_REQUEST_PATH_LIMIT = 25;

/**
 * The kind of change to one path, in the four words the answer speaks. Git's
 * own statuses are finer (`modified` vs `changed`, `renamed` vs `copied`) in
 * ways nothing downstream acts on.
 */
export type ChangeKind = 'added' | 'changed' | 'deleted' | 'moved';

/** One changed path. `previousPath` is where a `moved` one came from. */
export interface ChangeRequestSummaryFile {
  path: string;
  change: ChangeKind;
  previousPath?: string;
  /** Unified diff. Only with `include: ["patches"]`, and absent for a binary or oversized file. */
  patch?: string;
}

/**
 * Who must approve one path, at the same per-path granularity the detail
 * carries (the access tree resolves a role per file or per folder; this says
 * what it resolved to for this file).
 *
 * The detail's own entry is the dialog's: it also carries each approver's
 * email, the viewer's own eligibility, and every approval's timestamp and
 * staleness. Repeated over 25 files that is ~4,500 characters an agent cannot
 * act on — it may not approve anything — and it is what would push the
 * 27-file answer back over the limit this ticket exists to get under. So the
 * answer keeps what "who must approve" means and nothing else.
 */
export interface ChangeRequestApprovers {
  path: string;
  /** Roles that confer approval here. `everyone` means any signed-in approver. */
  roles: string[];
  /** Approvers named directly, by display name. */
  users: string[];
  /** True once an eligible approver has approved at the request's current head. */
  approved: boolean;
  /** False when the merge gate does not bind this path — then nobody has to approve it. */
  inMergeGate: boolean;
  /**
   * Present when the access tree could not be resolved for this path — which
   * includes a detail that carries no verdict at all. Then empty
   * `roles`/`users` means "not known", NOT "nobody has to approve".
   */
  approversUnknown?: true;
}

export interface ChangeRequestSummary {
  /** First field on purpose: it is the one an agent must hand the user. */
  url: string;
  urlNote?: string;
  number: number;
  title: string;
  state: ChangeRequestState;
  sourceBranch: string;
  targetBranch: string;
  /** Who must approve, one entry per listed path. */
  approvals: ChangeRequestApprovers[];
  /** What blocks the merge — verbatim from the detail. Empty when nothing does. */
  mergeBlockedReasons: string[];
  /** The changed paths, cut to {@link CHANGE_REQUEST_PATH_LIMIT} unless `all-paths` was asked for. */
  files: ChangeRequestSummaryFile[];
  /** How many files the request changes in total, cut or not. */
  totalFiles: number;
}

/**
 * A copy and a rename both carry `previousPath`, and the one thing a reader
 * does with either is look at where the text came from — so both read `moved`.
 * `unchanged` is a file the request lists without changing (git reports it on
 * a mode-only change); `changed` is the honest word for it among these four.
 */
function changeKindOf(status: PrFileStatus | undefined): ChangeKind {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'deleted';
    case 'renamed':
    case 'copied':
      return 'moved';
    default:
      return 'changed';
  }
}

function approversOf(approval: FileApproval): ChangeRequestApprovers {
  const eligible = approval.eligibleApprovers ?? { roles: [], users: [] };
  return {
    path: approval.path,
    roles: eligible.roles ?? [],
    users: (eligible.users ?? []).map((u) => u.name),
    approved: approval.isApproved,
    inMergeGate: approval.inMergeGate,
    // Anything but an explicit `true` is unresolved — a detail built before
    // the flag existed carries no flag at all, and reading that as "resolved"
    // would turn an empty approver set into "nobody must approve". Same
    // fail-closed reading as `computeViewerCanUpdate`.
    ...(approval.eligibilityResolved !== true ? { approversUnknown: true as const } : {}),
  };
}

function summaryFileOf(file: ChangedFile, withPatch: boolean): ChangeRequestSummaryFile {
  return {
    path: file.path,
    change: changeKindOf(file.status),
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
    ...(withPatch && file.patch ? { patch: file.patch } : {}),
  };
}

/**
 * Shape the tool's answer out of the detail the service already returns. Pure:
 * the service and the app's routes are untouched, and the detail they serve is
 * exactly what it was.
 *
 * `approvals` is narrowed to the paths the answer lists, because the detail's
 * contract is one entry per listed file. Nothing about the merge gate is lost
 * by that: `mergeBlockedReasons` names every missing approval, cut or not.
 */
export function summarizeChangeRequest(
  detail: ChangeRequestDetail,
  include: readonly ChangeRequestInclude[] = [],
): ChangeRequestSummary {
  const all = detail.files ?? [];
  const withPatch = include.includes('patches');
  const listed = include.includes('all-paths') ? all : all.slice(0, CHANGE_REQUEST_PATH_LIMIT);
  const listedPaths = new Set(listed.map((f) => f.path));
  return {
    url: detail.url,
    ...(detail.urlNote ? { urlNote: detail.urlNote } : {}),
    number: detail.number,
    title: detail.title,
    state: detail.state,
    sourceBranch: detail.branch,
    targetBranch: detail.base,
    approvals: (detail.approvals ?? []).filter((a) => listedPaths.has(a.path)).map(approversOf),
    mergeBlockedReasons: detail.mergeBlockedReasons ?? [],
    files: listed.map((f) => summaryFileOf(f, withPatch)),
    totalFiles: all.length,
  };
}

/** The `include` values off a tool call's arguments; anything else is ignored. */
export function parseInclude(raw: unknown): ChangeRequestInclude[] {
  if (!Array.isArray(raw)) return [];
  return CHANGE_REQUEST_INCLUDES.filter((v) => raw.includes(v));
}
