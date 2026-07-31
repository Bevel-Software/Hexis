import { and, asc, eq } from 'drizzle-orm';
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
import { changeRequests, prComments, prFileApprovals, prMergeLog } from '../../database/schema.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { isAccessMdPath } from '../../access/access-control.service.js';
import type { GitService } from '../git/git.service.js';
import {
  ChangeRequestConflictsError,
  WorkflowDomainError,
  WorkflowValidationError,
} from '../workflow.errors.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { hashEmail } from '../../../shared/hash-email.js';
import type {
  IReviewWorkflowService,
  MergeGateInput,
  MergeGateResult,
} from './review-workflow.interface.js';

// Merge commit (not squash): change requests can carry many meaningful commits
// (e.g. a bulk node upload split across files) and the KB's history is the audit
// trail — squashing would collapse them into one. A merge commit preserves every
// commit on the branch.
const MERGE_METHOD = 'merge' as const;
const EVERYONE_CANONICAL = 'everyone';
/** Repo-relative path of the access-config file the resolver gates as Admin-only. */
const ROLES_YAML = 'roles.yaml';

function redactTokens(msg: string): string {
  const tokens = [process.env.GITHUB_TOKEN, process.env.GH_TOKEN].filter(
    (t): t is string => !!t && t.length > 0,
  );
  return tokens.reduce((m, t) => m.replaceAll(t, '***'), msg);
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
      "You can't cancel this change request — only the author or an admin can.",
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
 * The access-config files the resolver treats as Admin-only to write
 * (`roles.yaml` decides admin membership; any `access.md` decides per-path
 * grants). These are NOT `.md` KB nodes but ARE the most security-critical
 * files in the repo, so the approval gate must bind them too — without this a
 * `roles.yaml`-only change request rides into a protected branch with no
 * approval and no admin check, letting its author self-promote to Admin.
 * Mirrors the resolver's own `relativePath === 'roles.yaml' || isAccessMdPath`
 * special-cases (access-control.service.ts). Paths are repo-relative, the same
 * form GitHub reports a PR's changed files in.
 */
function isAccessConfigPath(p: string): boolean {
  return p === ROLES_YAML || isAccessMdPath(p);
}

/**
 * Approval enforcement binds markdown KB nodes AND the access-config files
 * (`roles.yaml`, `access.md`) that have someone eligible to approve them per
 * the access tree. Files with no eligible approvers, and other non-md files,
 * are outside the gate — they neither warn nor block. Shared between the gate
 * and any call-site that needs the "does this participate in approvals"
 * question answered consistently.
 */
function isGateRelevant(a: FileApprovalState): boolean {
  const hasEligible =
    a.eligibleApprovers.roles.length > 0 || a.eligibleApprovers.users.length > 0;
  const lower = a.path.toLowerCase();
  return hasEligible && (lower.endsWith('.md') || isAccessConfigPath(a.path));
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
        authorEmail: user.email.trim().toLowerCase(),
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
    if (existing[0].authorEmail !== user.email.trim().toLowerCase()) {
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
    if (existing[0].authorEmail !== user.email.trim().toLowerCase()) {
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
    if (workspaceId) {
      await this.workspaceService.ensureRemotesFetched(workspaceId).catch(() => undefined);
      try {
        const resolved = await this.accessControl.eligibleWritersForPathsAtRef(
          workspaceId,
          baseRef,
          paths,
        );
        if (resolved) eligibilityByPath = resolved;
      } catch (err) {
        console.warn(
          `[review-workflow] eligibleWritersForPathsAtRef failed for PR #${prNumber} (base=${baseBranch}):`,
          err,
        );
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
          console.warn(
            `[review-workflow] canWriteBatchAtRef failed for PR #${prNumber} viewer=${viewerEmail}:`,
            err,
          );
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

      return {
        path: file.path,
        eligibleApprovers: { roles: eligible.roles, users: eligible.users },
        approvedBy,
        isApproved: hasEligibleApproval,
        viewerCanApprove: viewerCanApproveByPath.get(file.path) === true,
      };
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
    const callerEmail = user.email.trim().toLowerCase();

    // Unique index on (prNumber, path, approverEmail, headSha) makes this
    // idempotent — `onConflictDoNothing` turns a double-click into a no-op.
    await this.db
      .insert(prFileApprovals)
      .values({
        prNumber,
        path,
        approverEmail: callerEmail,
        approverName: user.name,
        headSha,
      })
      .onConflictDoNothing();

    return this.getApprovalStates(prNumber, files, headSha, baseBranch, prAuthorIdHash, workspaceId);
  }

  evaluateMergeGate(input: MergeGateInput): MergeGateResult {
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

    // Ownership enforcement only binds markdown KB nodes. Non-md files (TS,
    // JSON, images, etc.) and ownerless md files are silent — they neither
    // warn nor block. For the remaining gate-relevant files, "owner hasn't
    // approved the current head" is surfaced as a *warning* the caller can
    // bypass explicitly, not a hard block.
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
    // Hard blocks always refuse. Soft warnings refuse unless the caller opted
    // into bypass; with bypass, the bypassed warnings get inlined in the merge
    // commit body so git history captures the decision.
    const gate = this.evaluateMergeGate({ prNumber, state, approvals });
    if (!gate.mergeable) throw new MergeBlockedError(gate.reasons);
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

    const triggeredByEmail = user.email.trim().toLowerCase();
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
      const redacted = redactTokens(err instanceof Error ? err.message : String(err));
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

    const callerEmail = user.email.trim().toLowerCase();

    // Only revoke the caller's OWN approval — never someone else's. Filter on
    // (PR, path, approverEmail) without pinning the SHA so a user revoking
    // after a force-push can drop their stale row in one click.
    await this.db
      .delete(prFileApprovals)
      .where(
        and(
          eq(prFileApprovals.prNumber, prNumber),
          eq(prFileApprovals.path, path),
          eq(prFileApprovals.approverEmail, callerEmail),
        ),
      );

    return this.getApprovalStates(prNumber, files, headSha, baseBranch, prAuthorIdHash, workspaceId);
  }
}
