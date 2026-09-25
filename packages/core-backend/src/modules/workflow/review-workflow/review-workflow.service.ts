import { and, asc, eq } from 'drizzle-orm';
import { logger } from '../../../shared/logging.js';

const log = logger('review-workflow');
import type {
  AuthUser,
  CancelPrResult,
  FileApprovalEntry,
  FileApprovalState,
  MergePrResult,
  PostPrCommentInput,
  PrReviewComment,
  PullRequestFile,
  PullRequestState,
} from '@bevel-software/platform-shared';
import type { Database } from '../../database/connection.js';
import { changeRequests, prComments, prFileApprovals, prMergeLog, users } from '../../database/schema.js';
import { AccessUnreadableError } from '../../access-model/access-errors.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { GitService } from '../git/git.service.js';
import { redactSecret } from '../../../shared/redact-secret.js';
import {
  ChangeRequestConflictsError,
  WorkflowDomainError,
  WorkflowValidationError,
} from '../../../shared/domain-errors.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { canonicalEmail, hashEmail } from '../../../shared/email-identity.js';
import type {
  IReviewWorkflowService,
  MergeGateInput,
  MergeGateResult,
} from './review-workflow.interface.js';
import {
  APPROVAL_LOCK_TIMEOUT_MS,
  isApprovalLockTimeout,
  takeApprovalLock,
  takeEveryApprovalLock,
  type ApprovalTx,
} from './approval-lock.js';

// Merge commit (not squash): change requests can carry many meaningful commits
// (e.g. a bulk node upload split across files) and the KB's history is the audit
// trail — squashing would collapse them into one. A merge commit preserves every
// commit on the branch.
const MERGE_METHOD = 'merge' as const;
const EVERYONE_CANONICAL = 'everyone';

/**
 * Redact a git token from an error string before it is stored: the one the
 * knowledge base's runner authenticates with, plus whatever the environment
 * holds (`redactSecret` names those itself).
 */
function redactTokens(msg: string, token: string | null | undefined): string {
  return redactSecret(msg, [token]);
}

class CommentAuthError extends WorkflowDomainError {
  constructor(reason: 'not-found' | 'forbidden') {
    super(
      reason === 'not-found' ? 'Comment not found' : 'You can only edit your own comments',
      reason === 'not-found' ? 404 : 403,
    );
    this.name = 'CommentAuthError';
  }
}

/**
 * Another approval write on this same request is holding the lock and did not
 * let go. Retryable BY THE CALLER, and said in words a business user can act
 * on: nothing was written, and trying again is the whole fix.
 */
class ApprovalBusyError extends WorkflowDomainError {
  constructor() {
    super(
      'This change request is being updated right now — try that again in a moment.',
      503,
      { kind: 'approval-write-busy', retryable: true },
    );
    this.name = 'ApprovalBusyError';
  }
}

class MergeBlockedError extends WorkflowDomainError {
  constructor(reasons: string[]) {
    super(`Merge gate rejected: ${reasons.join('; ') || 'unknown'}`, 422, {
      mergeBlockedReasons: reasons,
    });
    this.name = 'MergeBlockedError';
  }
}

class MergeExecutionError extends WorkflowDomainError {
  constructor(reason: string) {
    super(`Merge failed: ${reason}`, 502);
    this.name = 'MergeExecutionError';
  }
}

class ApprovalAuthError extends WorkflowDomainError {
  constructor(reason: 'not-eligible' | 'no-eligible-approvers' | 'path-not-in-pr') {
    const { status, msg } = {
      'not-eligible':          { status: 403, msg: "You don't have write access on this file's path" },
      'no-eligible-approvers': { status: 422, msg: 'No one is eligible to approve this file — broaden the access.md rules covering it first' },
      'path-not-in-pr':        { status: 404, msg: 'Path is not part of this PR' },
    }[reason];
    super(msg, status);
    this.name = 'ApprovalAuthError';
  }
}

/**
 * The account this approval would be recorded in the name of is gone — erased
 * between the request being authenticated and its write reaching the table.
 *
 * 401 and not 403: the same answer `requireUser` gives a token whose account
 * no longer exists, which is what the NEXT request from this caller will get.
 * Signing in again makes a fresh account at the same address, and approvals
 * made then are that new person's.
 */
class ApprovalAccountGoneError extends WorkflowDomainError {
  constructor() {
    super('This account no longer exists — sign in again to approve.', 401, {
      kind: 'approval-account-erased',
    });
    this.name = 'ApprovalAccountGoneError';
  }
}

class BypassAuthError extends WorkflowDomainError {
  constructor() {
    super(
      "Only admins can merge with bypass. You need write access to roles.yaml on the base branch to skip approval warnings.",
      403,
    );
    this.name = 'BypassAuthError';
  }
}

class CancelStateError extends WorkflowDomainError {
  constructor(reason: 'already-applied' | 'already-cancelled') {
    const msg =
      reason === 'already-applied'
        ? 'This change request was already applied.'
        : 'This change request is already cancelled.';
    super(msg, 422);
    this.name = 'CancelStateError';
  }
}

class CancelAuthError extends WorkflowDomainError {
  constructor() {
    super(
      "You can't cancel this change request — that takes being its author, an admin, " +
        'or having edit access to every file it changes.',
      403,
    );
    this.name = 'CancelAuthError';
  }
}

function assertValidPrNumber(n: number): void {
  if (!Number.isInteger(n) || n <= 0) {
    throw new WorkflowValidationError('PR number must be a positive integer');
  }
}

function assertValidBody(body: string): void {
  const trimmed = body.trim();
  if (!trimmed) throw new WorkflowValidationError('comment body is required');
  if (trimmed.length > 64_000) {
    throw new WorkflowValidationError('comment body exceeds 64k character limit');
  }
}

function assertValidLine(line: number | undefined): void {
  if (line === undefined) return;
  if (!Number.isInteger(line) || line < 1 || line > 1_000_000) {
    throw new WorkflowValidationError('line must be a positive integer');
  }
}

// RFC 4122 — accepts any variant/version so legacy v1 ids still pass. Stricter
// than "any 32 hex" because Drizzle/PG reject mis-shaped strings with a 500,
// and we want a 4xx on malformed input from URL params / body fields.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertValidUuid(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new WorkflowValidationError(`${fieldName} must be a valid UUID`);
  }
}

/**
 * Approval enforcement binds every touched file that has someone eligible to
 * approve it per the access tree — Markdown notes, the access-config files
 * (`roles.yaml`, `access.md`), extensionless and binary files alike. The
 * extension plays no part: a `report.pdf` or a `Makefile` in an owned folder
 * is as much its owners' decision as a note beside it, and an extension check
 * let a request touching only such files merge with no approval at all. Files
 * with no eligible approvers are outside the gate — nobody could approve them,
 * so counting them would deadlock the request. Shared between the gate and
 * any call-site that needs the "does this participate in approvals" question
 * answered consistently.
 */
function isGateRelevant(a: Pick<FileApprovalState, 'eligibleApprovers'>): boolean {
  return a.eligibleApprovers.roles.length > 0 || a.eligibleApprovers.users.length > 0;
}

/** Human-friendly label for the eligible-approver set, used in gate warnings. */
function eligibleLabel(a: FileApprovalState): string {
  const parts: string[] = [];
  if (a.eligibleApprovers.roles.length) parts.push(a.eligibleApprovers.roles.join(', '));
  if (a.eligibleApprovers.users.length) {
    parts.push(
      a.eligibleApprovers.users
        .map((u) => (u.name ? `${u.name} <${u.email}>` : u.email))
        .join(', '),
    );
  }
  return parts.join('; ') || 'someone with write access';
}

/**
 * The gate split by what can override it: `hardReasons` (closed, merged, no
 * files) refuse every merge; `warnings` (missing approvals) refuse too, but
 * an admin may merge past them with the bypass flag.
 */
function evaluateGateParts(input: MergeGateInput): { hardReasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (input.state === 'merged') {
    reasons.push('This pull request has already been merged.');
  } else if (input.state === 'closed') {
    reasons.push('This pull request is closed.');
  }

  // Empty approvals = empty files array = nothing to approve. That's not
  // mergeable either — a PR that touches no files shouldn't be opened in
  // the first place, let alone merged.
  if (input.approvals.length === 0 && input.state === 'open') {
    reasons.push('This pull request has no file changes to approve.');
  }

  // Ownership enforcement binds every file with an eligible approver,
  // whatever its extension; files nobody can approve are silent. For the
  // gate-relevant files, "owner hasn't approved the current head" is a
  // missing approval — it blocks, and only an admin bypass merges past it.
  for (const a of input.approvals) {
    if (!isGateRelevant(a)) continue;
    if (a.isApproved) continue;

    const hasStale = a.approvedBy.some((e) => e.isStale);
    const label = eligibleLabel(a);
    if (hasStale) {
      warnings.push(`${label} need to re-approve ${a.path} after the latest push.`);
    } else {
      warnings.push(`Waiting on approval for ${a.path} from ${label}.`);
    }
  }

  return { hardReasons: reasons, warnings };
}

function assertValidPath(p: unknown): asserts p is string | undefined {
  if (p === undefined || p === null) return;
  if (typeof p !== 'string') throw new WorkflowValidationError('path must be a string');
  if (!p) throw new WorkflowValidationError('path, if provided, must be non-empty');
  if (p.length > 4096) throw new WorkflowValidationError('path exceeds 4096 character limit');
  if (p.includes('\0')) throw new WorkflowValidationError('path contains NUL');
}

function toDTO(row: typeof prComments.$inferSelect): PrReviewComment {
  return {
    id: row.id,
    author: { email: row.authorEmail, name: row.authorName },
    body: row.body,
    path: row.path ?? undefined,
    line: row.line ?? undefined,
    headSha: row.headSha,
    parentId: row.parentId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : undefined,
  };
}

export class ReviewWorkflowService implements IReviewWorkflowService {
  constructor(
    private readonly db: Database,
    private readonly accessControl: IAccessControl,
    private readonly workspaceService: WorkspaceService,
    private readonly git: GitService,
  ) {}

  async listComments(prNumber: number): Promise<PrReviewComment[]> {
    assertValidPrNumber(prNumber);
    const rows = await this.db
      .select()
      .from(prComments)
      .where(eq(prComments.prNumber, prNumber))
      .orderBy(asc(prComments.createdAt));
    return rows.map(toDTO);
  }

  async postComment(
    prNumber: number,
    user: AuthUser,
    input: PostPrCommentInput,
    headSha: string,
  ): Promise<PrReviewComment> {
    assertValidPrNumber(prNumber);
    assertValidBody(input.body);
    assertValidPath(input.path);
    assertValidLine(input.line);
    if (!headSha) throw new WorkflowValidationError('head sha is required');

    // Inline (line-level) comments must have a path; general comments may have neither.
    if (input.line !== undefined && !input.path) {
      throw new WorkflowValidationError('line comments require a file path');
    }

    // Validate parentId references a real comment on the same PR. UUID format
    // check first — PG rejects mis-shaped ids with a 500 from its uuid type,
    // so we convert that to a structured 4xx before hitting the DB. We skip a
    // depth check — trees deeper than two levels are rare and the UI flattens
    // them into a single reply chain for display.
    if (input.parentId !== undefined && input.parentId !== null) {
      assertValidUuid(input.parentId, 'parentId');
      const parent = await this.db
        .select()
        .from(prComments)
        .where(
          and(eq(prComments.id, input.parentId), eq(prComments.prNumber, prNumber)),
        )
        .limit(1);
      if (parent.length === 0) {
        throw new WorkflowValidationError('parent comment not found on this PR');
      }
    }

    const [row] = await this.db
      .insert(prComments)
      .values({
        prNumber,
        authorEmail: canonicalEmail(user.email),
        authorName: user.name,
        path: input.path ?? null,
        line: input.line ?? null,
        headSha,
        body: input.body.trim(),
        parentId: input.parentId ?? null,
      })
      .returning();
    return toDTO(row);
  }

  async editComment(
    commentId: string,
    prNumber: number,
    user: AuthUser,
    body: string,
  ): Promise<PrReviewComment> {
    assertValidPrNumber(prNumber);
    assertValidUuid(commentId, 'comment id');
    assertValidBody(body);
    // Scope lookup to (id, prNumber) so a guessed id from another PR 404s
    // rather than leaking existence / touching a foreign comment.
    const existing = await this.db
      .select()
      .from(prComments)
      .where(and(eq(prComments.id, commentId), eq(prComments.prNumber, prNumber)))
      .limit(1);
    if (existing.length === 0) throw new CommentAuthError('not-found');
    if (existing[0].authorEmail !== canonicalEmail(user.email)) {
      throw new CommentAuthError('forbidden');
    }
    const [row] = await this.db
      .update(prComments)
      .set({ body: body.trim(), updatedAt: new Date() })
      .where(and(eq(prComments.id, commentId), eq(prComments.prNumber, prNumber)))
      .returning();
    return toDTO(row);
  }

  async deleteComment(commentId: string, prNumber: number, user: AuthUser): Promise<void> {
    assertValidPrNumber(prNumber);
    assertValidUuid(commentId, 'comment id');
    const existing = await this.db
      .select()
      .from(prComments)
      .where(and(eq(prComments.id, commentId), eq(prComments.prNumber, prNumber)))
      .limit(1);
    if (existing.length === 0) throw new CommentAuthError('not-found');
    if (existing[0].authorEmail !== canonicalEmail(user.email)) {
      throw new CommentAuthError('forbidden');
    }
    await this.db
      .delete(prComments)
      .where(and(eq(prComments.id, commentId), eq(prComments.prNumber, prNumber)));
  }

  async getApprovalStates(
    prNumber: number,
    files: PullRequestFile[],
    headSha: string,
    baseBranch: string,
    prAuthorIdHash: string | null,
    workspaceId?: string,
    viewerEmail?: string,
  ): Promise<FileApprovalState[]> {
    assertValidPrNumber(prNumber);

    // Eligible approvers are resolved against `origin/<baseBranch>` — the
    // PR's target. Reading from the PR head would let the PR author grant
    // themselves approval rights via access.md edits in their own branch;
    // reading from the working tree would let any user with edit access to
    // access.md do the same locally. Both are privilege-escalation paths.
    // Origin's protected branches are fast-forward-only (they're gated by
    // their own PR review), so they're the authoritative source.
    //
    // Without a workspace we can't do the git-show lookup, so return
    // entries with empty eligibility and let the caller decide.
    const baseRef = `origin/${baseBranch}`;
    const paths = files.map((f) => f.path);
    let eligibilityByPath: Map<
      string,
      {
        roles: string[];
        users: { name: string; email: string }[];
        emails: Set<string>;
        excludedEmails?: Set<string>;
      }
    > = new Map();
    // Viewer-can-approve runs the same gate the Approve route applies, but
    // batched per PR. Default is false — both when the access tree can't be
    // resolved (no workspace, fetch failure, no roles.yaml on base) and when
    // the caller is unauthenticated. The frontend can still surface the
    // eligible roles/users list; it just won't render an Approve button.
    let viewerCanApproveByPath: Map<string, boolean> = new Map();
    let eligibilityResolved = false;
    if (workspaceId) {
      await this.workspaceService.ensureRemotesFetched(workspaceId).catch(() => undefined);
      try {
        const resolved = await this.accessControl.eligibleWritersForPathsAtRef(
          workspaceId,
          baseRef,
          paths,
        );
        if (resolved) {
          eligibilityByPath = resolved;
          eligibilityResolved = true;
        }
      } catch (err) {
        // An unreadable tree is not "no eligible writers": that answer would
        // drop every file out of the merge gate. Fail closed instead.
        if (err instanceof AccessUnreadableError) throw err;
        log.warn(`eligibleWritersForPathsAtRef failed for PR #${prNumber} (base=${baseBranch}):`, { err });
      }

      if (viewerEmail) {
        try {
          const batch = await this.accessControl.canWriteBatchAtRef(
            workspaceId,
            baseRef,
            viewerEmail,
            paths,
          );
          if (batch) viewerCanApproveByPath = batch;
        } catch (err) {
          if (err instanceof AccessUnreadableError) throw err;
          log.warn(`canWriteBatchAtRef failed for PR #${prNumber} viewer=${viewerEmail}:`, { err });
        }
      }
    }

    // One round-trip for all approvals on this PR. Filtering + staleness check
    // happens in memory — trivial at the expected row counts.
    const rows = await this.db
      .select()
      .from(prFileApprovals)
      .where(eq(prFileApprovals.prNumber, prNumber));

    return files.map((file): FileApprovalState => {
      const eligible = eligibilityByPath.get(file.path) ?? {
        roles: [],
        users: [] as { name: string; email: string }[],
        emails: new Set<string>(),
      };
      const pathRows = rows.filter((r) => r.path === file.path);

      const approvedBy: FileApprovalEntry[] = pathRows.map((r) => ({
        email: r.approverEmail,
        name: r.approverName,
        approvedAt: r.approvedAt.toISOString(),
        isStale: r.headSha !== headSha,
        isSelfApproval: prAuthorIdHash ? hashEmail(r.approverEmail) === prAuthorIdHash : false,
      }));

      // A file is approved when any eligible writer (per the access tree on
      // `origin/<baseBranch>`) has a non-stale approval against the current
      // head SHA. Files with no eligible writers can't be approved and are
      // silently excluded from the merge gate by `isGateRelevant`.
      // `everyone` write grant means any signed-in approver qualifies — except
      // those carved out by a denial at any tier (`deny email` / `deny role` /
      // `deny everyone`), captured in `excludedEmails`. Otherwise only the
      // explicitly-eligible writers in `emails` can approve.
      const everyoneCanApprove = eligible.roles.includes(EVERYONE_CANONICAL);
      const excludedEmails = eligible.excludedEmails ?? new Set<string>();
      const hasEligibleApproval =
        (everyoneCanApprove || eligible.emails.size > 0) &&
        pathRows.some(
          (r) => {
            const approverEmail = r.approverEmail.toLowerCase();
            if (r.headSha !== headSha) return false;
            return everyoneCanApprove
              ? !excludedEmails.has(approverEmail)
              : eligible.emails.has(approverEmail);
          },
        );

      const state = {
        path: file.path,
        eligibleApprovers: { roles: eligible.roles, users: eligible.users },
        approvedBy,
        eligibilityResolved,
        isApproved: hasEligibleApproval,
        viewerCanApprove: viewerCanApproveByPath.get(file.path) === true,
      };
      return { ...state, inMergeGate: isGateRelevant(state) };
    });
  }

  async approveFile(
    prNumber: number,
    path: string,
    user: AuthUser,
    files: PullRequestFile[],
    headSha: string,
    baseBranch: string,
    prAuthorIdHash: string | null,
    workspaceId: string,
  ): Promise<FileApprovalState[]> {
    assertValidPrNumber(prNumber);
    assertValidPath(path);
    if (!headSha) throw new WorkflowValidationError('head sha is required');
    if (!baseBranch) throw new WorkflowValidationError('base branch is required');

    if (!files.some((f) => f.path === path)) {
      throw new ApprovalAuthError('path-not-in-pr');
    }

    // Resolve eligibility against `origin/<baseBranch>` — the canonical
    // access tree for the PR's target. Reading from the PR head or the
    // working tree would let users grant themselves approval rights via
    // local edits to access.md. Fetch remotes first so the ref resolves
    // on a clone that hasn't seen recent base updates.
    await this.workspaceService.ensureRemotesFetched(workspaceId).catch(() => undefined);
    const canApprove = await this.accessControl.canWriteAtRef(
      workspaceId,
      `origin/${baseBranch}`,
      user.email,
      path,
    );
    if (canApprove === null) throw new ApprovalAuthError('no-eligible-approvers');
    if (!canApprove) throw new ApprovalAuthError('not-eligible');
    const callerEmail = canonicalEmail(user.email);

    // Unique index on (prNumber, path, approverEmail, headSha) makes this
    // idempotent — `onConflictDoNothing` turns a double-click into a no-op.
    //
    // Under the same per-request lock the carry-forward takes: an approval
    // that landed between that copy's select and its insert would be pinned to
    // the head the update was replacing and silently dropped from the request
    // it was made on. Serialized, the approval either precedes the copy and is
    // carried with the rest, or follows it and is honestly an approval of a
    // head that has already moved — which the dialog then shows as stale.
    await this.withApprovalLock(prNumber, async (tx) => {
      // Is there still an account to record this in the name of?
      //
      // The route proved there was before the access read above, and that read
      // fetches remotes — seconds, on a cold clone. An erasure that commits in
      // that window has already rewritten every row this person's address was
      // on, so an insert landing after it would put the address back, on a row
      // created after the last trace of them was supposed to be gone. The lock
      // makes the two orderings the only two: erased first and this finds
      // nothing and refuses; approved first and the erasure's own rewrite —
      // which waits for this transaction — takes the new row with the rest.
      //
      // By id, not by address: a NEW account signed in at the same address
      // since is a different person, and this caller is not them.
      const [account] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);
      if (!account) throw new ApprovalAccountGoneError();
      await tx
        .insert(prFileApprovals)
        .values({
          prNumber,
          path,
          approverEmail: callerEmail,
          approverName: user.name,
          headSha,
        })
        .onConflictDoNothing();
    });

    // WITH the caller as viewer: these approvals go straight back to the UI
    // that just clicked, and omitting the viewer computed every
    // `viewerCanApprove` as false — one approval made the apply button and
    // every remaining approve control vanish until a fresh detail fetch.
    return this.getApprovalStates(prNumber, files, headSha, baseBranch, prAuthorIdHash, workspaceId, user.email);
  }

  /**
   * See the interface. The lock is taken right before the statement it has to
   * cover, not at the top of the caller's transaction: what it orders is this
   * rewrite and everything after it, and every millisecond earlier is that
   * much longer for approvals to queue behind an erasure.
   */
  async eraseApprover(
    tx: ApprovalTx,
    email: string,
    erased: { email: string; name: string },
  ): Promise<void> {
    await takeEveryApprovalLock(tx);
    await tx
      .update(prFileApprovals)
      .set({ approverEmail: erased.email, approverName: erased.name })
      .where(eq(prFileApprovals.approverEmail, email));
  }

  /**
   * Pure in `this`: the whole verdict comes out of `evaluateGateParts`, a
   * module-level function. Call-sites borrow this off the prototype against a
   * bare object to get the real gate without a service, so keep it that way —
   * reaching for an instance field here breaks them with a TypeError.
   */
  evaluateMergeGate(input: MergeGateInput): MergeGateResult {
    // A missing approval is both: a blocking reason (the request is not
    // mergeable while it remains) and a warning (the admin bypass names it).
    const { hardReasons, warnings } = evaluateGateParts(input);
    const reasons = [...hardReasons, ...warnings];
    return { mergeable: reasons.length === 0, reasons, warnings };
  }

  async mergePr(
    prNumber: number,
    user: AuthUser,
    headSha: string,
    approvals: FileApprovalState[],
    state: PullRequestState,
    prTitle: string,
    baseBranch: string,
    workspaceId: string,
    opts: { bypass?: boolean } = {},
  ): Promise<MergePrResult> {
    assertValidPrNumber(prNumber);
    if (!headSha) throw new WorkflowValidationError('head sha is required');
    if (!baseBranch) throw new WorkflowValidationError('base branch is required');
    if (!workspaceId) throw new WorkflowValidationError('workspace id is required');

    // Server-side re-validation — never trust the frontend's cached gate.
    // Hard blocks always refuse. Missing approvals refuse unless the caller
    // opted into bypass; with bypass, the bypassed warnings get inlined in the
    // merge commit body so git history captures the decision.
    const gate = evaluateGateParts({ prNumber, state, approvals });
    if (gate.hardReasons.length > 0) throw new MergeBlockedError(gate.hardReasons);
    if (gate.warnings.length > 0 && !opts.bypass) {
      throw new MergeBlockedError(gate.warnings);
    }

    // Bypass authority: admin-only. Resolved against `origin/<baseBranch>`
    // (same authoritative source the approval gate uses) so a PR author
    // can't grant themselves bypass rights by editing roles.yaml in their
    // own branch. Using `canWriteAtRef(..., 'roles.yaml')` because
    // `canWriteResolved` short-circuits that path to "is the caller in the
    // Admin role"; that's exactly the predicate we want here. A null result
    // (no usable access config on origin/<base>) is treated as "no admin can
    // be identified, no bypass" — the safe default for a misconfigured tree.
    if (opts.bypass && gate.warnings.length > 0) {
      const isAdmin = await this.accessControl.canWriteAtRef(
        workspaceId,
        `origin/${baseBranch}`,
        user.email,
        'roles.yaml',
      );
      if (isAdmin !== true) throw new BypassAuthError();
    }

    // Authoritative branches come from the CR row, not the passed baseBranch
    // (which only drove the gate) — the merge acts on what the row records.
    const [cr] = await this.db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.number, prNumber))
      .limit(1);
    if (!cr) throw new WorkflowValidationError(`Change request #${prNumber} not found`);
    // Re-validate lifecycle against the AUTHORITATIVE row, not the caller's
    // `state` (which only drove the gate). A stale or duplicate request must not
    // re-run the git merge on a CR that's already merged or closed.
    if (cr.state !== 'open') {
      throw new MergeBlockedError([
        cr.state === 'merged'
          ? 'This change request has already been merged.'
          : 'This change request is closed.',
      ]);
    }

    const triggeredByEmail = canonicalEmail(user.email);
    const [logRow] = await this.db
      .insert(prMergeLog)
      .values({
        prNumber,
        triggeredByEmail,
        triggeredByName: user.name,
        headShaAtMerge: headSha,
        mergeMethod: MERGE_METHOD,
        succeeded: false,
      })
      .returning({ id: prMergeLog.id });

    // Attribution lives on the merge commit itself (authored as the human
    // triggerer). When bypass is used, the bypassed warnings are appended so the
    // decision survives in git history — no separate audit table needed.
    const subject = `${prTitle} (#${prNumber})`;
    const bypassFooter =
      opts.bypass && gate.warnings.length > 0
        ? `\n\nApproval requirements bypassed:\n${gate.warnings.map((w) => `- ${w}`).join('\n')}`
        : '';
    const body = `Merged via Bevel by ${user.name} <${user.email}>${bypassFooter}`;

    // The actual merge: local `git merge --no-ff` on the base branch's workspace,
    // pushed to origin. Provider-agnostic — no PR API. A merge failure flips the
    // log to `succeeded: false` and surfaces MergeExecutionError; a conflict is a
    // caller-resolvable precondition (ChangeRequestConflictsError, 409).
    const baseWorkspace = await this.workspaceService.getOrCreateForBranch(cr.targetBranch);
    let mergeResult: Awaited<ReturnType<GitService['mergeChangeRequest']>>;
    try {
      mergeResult = await this.git.mergeChangeRequest(
        baseWorkspace.id,
        cr.sourceBranch,
        cr.targetBranch,
        { subject, body },
        user,
      );
    } catch (err) {
      const redacted = redactTokens(err instanceof Error ? err.message : String(err), this.git.credentials?.token());
      await this.db
        .update(prMergeLog)
        .set({ succeeded: false, completedAt: new Date(), error: redacted })
        .where(eq(prMergeLog.id, logRow.id));
      throw new MergeExecutionError(redacted);
    }

    if (mergeResult.kind === 'conflicts') {
      await this.db
        .update(prMergeLog)
        .set({
          succeeded: false,
          completedAt: new Date(),
          error: `conflicts: ${mergeResult.paths.join(', ')}`,
        })
        .where(eq(prMergeLog.id, logRow.id));
      throw new ChangeRequestConflictsError(cr.sourceBranch, cr.targetBranch, mergeResult.paths);
    }

    // Merged. Record CR + log success together; do the CR-state update FIRST so
    // the merge is durably reflected even if the log write hiccups. Gate the
    // write on the row STILL being `open` (CAS): if a concurrent merge/close won
    // the race between our lifecycle re-check above and here, `.returning()` is
    // empty and we refuse to clobber its terminal state instead of overwriting.
    const completedAt = new Date();
    const [updatedCr] = await this.db
      .update(changeRequests)
      .set({ state: 'merged', mergedSha: mergeResult.sha, closedAt: completedAt, updatedAt: completedAt })
      .where(and(eq(changeRequests.id, cr.id), eq(changeRequests.state, 'open')))
      .returning({ id: changeRequests.id });
    if (!updatedCr) {
      // A concurrent merge won the CAS between our lifecycle re-check and here.
      // Our own git merge was a harmless idempotent no-op, but this attempt did
      // NOT finalize the CR. Finalize this log row with an explanatory error and
      // a completedAt so it doesn't linger as a phantom `succeeded=false,
      // error=null` entry that a "failed merges" audit query would misread.
      const raceError = 'Change request was merged by a concurrent request; this attempt did not finalize it.';
      await this.db
        .update(prMergeLog)
        .set({ succeeded: false, completedAt, error: raceError })
        .where(eq(prMergeLog.id, logRow.id));
      throw new MergeExecutionError(raceError);
    }
    await this.db
      .update(prMergeLog)
      .set({ succeeded: true, completedAt })
      .where(eq(prMergeLog.id, logRow.id));

    return {
      prNumber,
      sha: mergeResult.sha,
      mergedAt: completedAt.toISOString(),
    };
  }

  async cancelPr(
    prNumber: number,
    user: AuthUser,
    state: PullRequestState,
    authorIdHash: string | null,
    baseBranch: string,
    workspaceId: string,
  ): Promise<CancelPrResult> {
    assertValidPrNumber(prNumber);
    if (!baseBranch) throw new WorkflowValidationError('base branch is required');
    if (!workspaceId) throw new WorkflowValidationError('workspace id is required');

    // Refuse early on terminal states so the gh call only fires for genuinely
    // open PRs. Two distinct 422s — frontend distinguishes "already applied"
    // from "already cancelled" in friendlyGitError to drive different copy.
    if (state === 'merged') throw new CancelStateError('already-applied');
    if (state === 'closed') throw new CancelStateError('already-cancelled');

    // Authorization: author OR admin. Author check is a pure hash compare; the
    // admin check shells through to the access tree on origin/<base>. Same
    // canWriteAtRef call mergePr's bypass uses — never resolve against the PR
    // head or working tree (privilege-escalation paths). Fetch remotes first so
    // the ref resolves on a clone that hasn't seen recent base updates.
    const viewerIsAuthor = !!(authorIdHash && authorIdHash === hashEmail(user.email));
    let viewerIsAdmin = false;
    if (!viewerIsAuthor) {
      // Fetch failure is non-authoritative: skip the admin check rather than
      // resolve roles.yaml against a stale local ref (could grant admin to
      // someone who was just demoted on origin).
      let fetchOk = true;
      try {
        await this.workspaceService.ensureRemotesFetched(workspaceId);
      } catch {
        fetchOk = false;
      }
      if (fetchOk) {
        const isAdmin = await this.accessControl.canWriteAtRef(
          workspaceId,
          `origin/${baseBranch}`,
          user.email,
          'roles.yaml',
        );
        viewerIsAdmin = isAdmin === true;
      }
    }
    if (!viewerIsAuthor && !viewerIsAdmin) throw new CancelAuthError();

    // Close = flip the row to `closed`. Guard on `state = 'open'` so a race
    // (someone merged/closed it between the pre-check and here) updates zero
    // rows; we then re-read to return the precise already-applied /
    // already-cancelled error the client renders distinct copy for. The source
    // branch is intentionally left intact — the author may still want it.
    const now = new Date();
    const updated = await this.db
      .update(changeRequests)
      .set({ state: 'closed', closedAt: now, updatedAt: now })
      .where(and(eq(changeRequests.number, prNumber), eq(changeRequests.state, 'open')))
      .returning({ id: changeRequests.id });

    if (updated.length === 0) {
      const [row] = await this.db
        .select({ state: changeRequests.state })
        .from(changeRequests)
        .where(eq(changeRequests.number, prNumber))
        .limit(1);
      throw new CancelStateError(row?.state === 'merged' ? 'already-applied' : 'already-cancelled');
    }

    return {
      prNumber,
      cancelledAt: now.toISOString(),
    };
  }

  /**
   * Carry the per-file approvals across a commit that the APPROVERS did not
   * make — the merge an update-from-target lands on the proposal's branch.
   *
   * An approval is pinned to a head sha (that is what makes an author's own
   * later edit reset it), so a merge commit voided every approval on the
   * request, including the many files it never touched. Reviewers then had to
   * re-approve text nobody had changed, which is how automatic updates would
   * have turned every stale request into a second round of review.
   *
   * What survives is decided by CONTENT, not by trust: `changedPaths` is
   * every path whose bytes differ between the two heads, and only a path
   * absent from it keeps its approval. The original `approvedAt` travels with
   * the row, because the reviewer approved then, not now. Idempotent under
   * the unique index, so a retried or concurrent update inserts nothing twice.
   *
   * Read and write sit inside one `withApprovalLock` transaction because a
   * REVOKE landing between them would otherwise be undone: `unapproveFile`
   * deletes the approver's rows at every head, and a copy taken before that
   * delete would re-insert the row it just removed, silently restoring an
   * approval its owner withdrew. Under the lock the two orderings are the only
   * two possible ones — revoke first, and the select finds nothing to carry;
   * carry first, and the revoke's delete sees both rows and takes both.
   *
   * Returns how many rows were actually WRITTEN (`returning()`, not the size
   * of the candidate list): on a retry where every row already exists nothing
   * is written, and the caller re-reads the detail only when that is non-zero.
   */
  async carryApprovalsForward(
    prNumber: number,
    fromHeadSha: string,
    toHeadSha: string,
    changedPaths: string[],
  ): Promise<number> {
    assertValidPrNumber(prNumber);
    if (!fromHeadSha || !toHeadSha) {
      throw new WorkflowValidationError('both head shas are required');
    }
    if (fromHeadSha === toHeadSha) return 0;

    const written = await this.withApprovalLock(prNumber, async (tx) => {
      const rows = await tx
        .select()
        .from(prFileApprovals)
        .where(
          and(eq(prFileApprovals.prNumber, prNumber), eq(prFileApprovals.headSha, fromHeadSha)),
        );
      const touched = new Set(changedPaths);
      const carried = rows
        .filter((r) => !touched.has(r.path))
        .map((r) => ({
          prNumber,
          path: r.path,
          approverEmail: r.approverEmail,
          approverName: r.approverName,
          headSha: toHeadSha,
          approvedAt: r.approvedAt,
        }));
      if (carried.length === 0) return [];
      return tx.insert(prFileApprovals).values(carried).onConflictDoNothing().returning();
    });
    if (written.length === 0) return 0;

    log.info(
      `carried ${written.length} approval(s) forward on PR #${prNumber} from ${fromHeadSha} to ${toHeadSha}`,
    );
    return written.length;
  }

  /**
   * Run one change request's approval write under the lock every writer of
   * these rows takes (see `approval-lock.ts` for what it orders and why),
   * inside one transaction that holds it until it commits or rolls back.
   *
   * Every approval write this service makes goes through here — carry forward,
   * approve, revoke — because a write that skipped it would be exactly the one
   * that interleaves with the others. Account erasure, in another module,
   * takes the same lock's exclusive form.
   *
   * Keep the body SHORT — no git, no network, no access-control read. This
   * holds a lock and a pooled connection; `approveFile` and `unapproveFile`
   * deliberately leave their access checks and their detail re-read outside.
   *
   * The wait is bounded, and hitting that bound is reported as the retryable
   * refusal it is: nothing was written.
   */
  private async withApprovalLock<T>(
    prNumber: number,
    fn: (tx: ApprovalTx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        await takeApprovalLock(tx, prNumber);
        return fn(tx);
      });
    } catch (err) {
      if (isApprovalLockTimeout(err)) {
        log.warn(
          `gave up waiting for the approval lock on PR #${prNumber} after ${APPROVAL_LOCK_TIMEOUT_MS}ms`,
        );
        throw new ApprovalBusyError();
      }
      throw err;
    }
  }

  async unapproveFile(
    prNumber: number,
    path: string,
    user: AuthUser,
    files: PullRequestFile[],
    headSha: string,
    baseBranch: string,
    prAuthorIdHash: string | null,
    workspaceId: string,
  ): Promise<FileApprovalState[]> {
    assertValidPrNumber(prNumber);
    assertValidPath(path);
    if (!headSha) throw new WorkflowValidationError('head sha is required');

    const callerEmail = canonicalEmail(user.email);

    // Only revoke the caller's OWN approval — never someone else's. Filter on
    // (PR, path, approverEmail) without pinning the SHA so a user revoking
    // after a force-push can drop their stale row in one click.
    //
    // Under the same per-request lock `carryApprovalsForward` takes: an
    // automatic update copies the approvals of the head it is replacing onto
    // the new one, and a delete that interleaved with that copy would be
    // undone by it — the revoked approval would come back at the new head.
    await this.withApprovalLock(prNumber, async (tx) => {
      await tx
        .delete(prFileApprovals)
        .where(
          and(
            eq(prFileApprovals.prNumber, prNumber),
            eq(prFileApprovals.path, path),
            eq(prFileApprovals.approverEmail, callerEmail),
          ),
        );
    });

    // WITH the caller as viewer: these approvals go straight back to the UI
    // that just clicked, and omitting the viewer computed every
    // `viewerCanApprove` as false — one approval made the apply button and
    // every remaining approve control vanish until a fresh detail fetch.
    return this.getApprovalStates(prNumber, files, headSha, baseBranch, prAuthorIdHash, workspaceId, user.email);
  }
}
