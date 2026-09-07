/**
 * Workflow domain errors. This is the single source of truth — every error
 * raised by the workflow domain (branches, changes, change requests, access
 * control, locks) lives here. Route handlers shape responses via the
 * `.status` + `.payload` contract on the base class.
 *
 * Lives in `src/shared` (not `modules/workflow`) because the classes are
 * consumed across module boundaries — access, diff, plugins and workspace all
 * catch or raise them — and `src/shared` is the layer with no module imports.
 * Only a type from `@bevel-software/platform-shared` comes in; nothing else.
 *
 * Naming: classes use workflow vocabulary. `WorkflowDomainError` is the
 * abstract base; specific subclasses describe the workflow concept that
 * went wrong (`BranchNameError`, `ProtectedBranchError`, etc.). Where a
 * concept is purely git mechanics with no workflow analogue
 * (`NoSharedHistoryError`), the name keeps its git flavour because
 * consumers actually need to discriminate on it.
 */

import type { ValidationReport } from '@bevel-software/platform-shared';

export class WorkflowDomainError extends Error {
  readonly status: number;
  readonly payload?: Record<string, unknown>;
  constructor(message: string, status: number, payload?: Record<string, unknown>) {
    super(message);
    this.name = 'WorkflowDomainError';
    this.status = status;
    this.payload = payload;
  }
}

export class BranchNameError extends WorkflowDomainError {
  constructor(reason: string, readonly branchName: string) {
    super(`Invalid branch name "${branchName}": ${reason}`, 400);
    this.name = 'BranchNameError';
  }
}

export class ProtectedBranchError extends WorkflowDomainError {
  constructor(readonly branchName: string, readonly action: string) {
    super(`Branch "${branchName}" is protected — ${action} is not allowed.`, 403);
    this.name = 'ProtectedBranchError';
  }
}

/**
 * The caller tried to delete a branch they don't own. Authorship is inferred
 * from the `<email-localpart>/<slug>` naming convention used by
 * `slugifyDraftName` — see `isBranchAuthoredBy` in `@bevel-software/platform-shared`.
 *
 * Distinct from `AccessDeniedError` because that error is path-based
 * (file-level write permission via `roles.yaml`/`access.md`). Branch
 * authorship is identity-based and has no eligible-roles list to surface —
 * the only way for someone else to delete a non-author's branch is to push
 * the delete via git CLI directly.
 */
export class BranchAuthorshipError extends WorkflowDomainError {
  readonly kind = 'branch-authorship' as const;
  constructor(readonly branchName: string) {
    super(
      `Only the author of "${branchName}" can delete it.`,
      403,
      { kind: 'branch-authorship', branchName },
    );
    this.name = 'BranchAuthorshipError';
  }
}

// `DirtyWorkingTreeError` removed: under save=share + per-branch workspaces
// no operation in the workflow can legitimately encounter a dirty working
// tree. The two former callers (`switchBranch` and `mergeFromOrigin`'s
// pre-flight) are gone / relaxed; if a dirty tree ever shows up it's an
// internal bug that gets server-side-logged in `statusInternal`, never
// surfaced as a user-facing 409.

/**
 * The local commit landed but pushing it to origin failed because the
 * remote diverged (a teammate or the agent landed competing commits while
 * the lock was held). The cooperative recovery — `pull --rebase` + retry
 * push — also failed, because the divergence touches the same file and the
 * rebase conflicts.
 *
 * Per the "disk is the source of truth" rule we do NOT auto-force-push
 * from the workflow layer (that's a destructive history rewrite that can
 * lose teammate work irrecoverably). Instead we surface this structured
 * error so the frontend can seed an agent prompt — the agent has git + gh
 * CLI access plus the lock-aware write tool, so it can read both sides,
 * semantically merge, and save the resolved file through the normal
 * save=share pipeline. The user sees only a loading indicator; the agent
 * does the reconciliation.
 *
 * State at the moment this fires:
 *   - The local branch has the user's just-committed change as its HEAD.
 *   - The lock has already been released (lock release runs BEFORE the
 *     push attempt). The agent can acquire its own lock.
 *   - `origin/<branch>` has commits the local clone doesn't reach.
 *   - The working tree is clean (the commit landed).
 *
 * The payload carries enough context that the prompt builder can phrase
 * the resolution request to the agent without further server round-trips.
 */
export class PushNeedsAgentResolutionError extends WorkflowDomainError {
  readonly kind = 'push-needs-resolution' as const;
  constructor(
    readonly branch: string,
    readonly path: string,
    readonly originalDetail: string,
    readonly recoveryDetail: string,
  ) {
    super(
      `Saved locally on "${branch}" but couldn't share with the team automatically — ` +
        `the remote diverged on "${path}" and the cooperative rebase couldn't reconcile. ` +
        `The agent will resolve this.`,
      409,
      {
        kind: 'push-needs-resolution',
        branch,
        path,
        originalDetail,
        recoveryDetail,
      },
    );
    this.name = 'PushNeedsAgentResolutionError';
  }
}

/**
 * Refreshing a workspace from origin (`GitService.pull`) hit a rebase
 * conflict: the workspace carries local commits origin doesn't have, origin
 * moved ahead with changes that touch the same files, and replaying the
 * local commits conflicts. The rebase has already been aborted — the
 * workspace is back in its pre-pull state (diverged, clean tree).
 *
 * This state does NOT resolve itself: every subsequent pull hits the same
 * conflict, and the local commits (someone's saved content, under
 * save=share) stay unshared until the divergence is reconciled. The service
 * layer therefore reacts by queueing a background recovery run (see
 * `WorkflowService.updateFromRemote`); this error tells the caller what
 * happened and which paths are contested.
 *
 * 409 like the other conflict errors — the operation needs the divergence
 * cleared before it can succeed. `detail` (the raw git failure, already
 * credential-redacted by `GitService.git`) is kept OFF the payload; it's for
 * server logs and the recovery pipeline, not the client.
 */
export class PullRebaseConflictError extends WorkflowDomainError {
  readonly kind = 'pull-rebase-conflict' as const;
  constructor(
    readonly branch: string,
    readonly conflictedPaths: string[],
    readonly detail: string,
  ) {
    const list = conflictedPaths.join(', ');
    super(
      `Updating "${branch}" from origin hit conflicts in ${conflictedPaths.length} file(s): ${list}. ` +
        `Automatic background recovery has been queued.`,
      409,
      {
        kind: 'pull-rebase-conflict',
        branch,
        conflictedPaths,
      },
    );
    this.name = 'PullRebaseConflictError';
  }
}

/**
 * The clone's branch no longer exists on origin: the fetch that refreshes
 * `refs/remotes/origin/<branch>` found no such ref. Distinct from an
 * unreachable remote — the host answered, and the answer was "gone" — so a
 * caller can treat the clone as stale rather than the sync as failed. 410.
 */
export class RemoteBranchGoneError extends WorkflowDomainError {
  readonly kind = 'remote-branch-gone' as const;
  constructor(readonly branch: string) {
    super(`Branch "${branch}" no longer exists on the remote.`, 410, {
      kind: 'remote-branch-gone',
      branch,
    });
    this.name = 'RemoteBranchGoneError';
  }
}

/**
 * Generic 400 for workflow-input validation (malformed branch names, missing
 * fields, etc.). Carries an optional payload so callers can attach typed
 * discriminators (`kind: '...'`) when the frontend needs to switch on the
 * specific failure mode.
 */
export class WorkflowValidationError extends WorkflowDomainError {
  constructor(message: string, payload?: Record<string, unknown>) {
    super(message, 400, payload);
    this.name = 'WorkflowValidationError';
  }
}

/**
 * The draft branch doesn't share history with the target branch, so GitHub
 * would reject the change request with `no history in common`. Surfaced as
 * a structured payload so the frontend's typed-error parser can route into
 * the agent recovery flow.
 */
export class NoSharedHistoryError extends WorkflowDomainError {
  readonly kind = 'no-shared-history' as const;
  constructor(readonly head: string, readonly base: string) {
    super(
      `The draft "${head}" doesn't share history with "${base}". ` +
        `It was likely started outside the app or from an unrelated point.`,
      400,
      { kind: 'no-shared-history', head, base },
    );
    this.name = 'NoSharedHistoryError';
  }
}

/**
 * The KB validator reported `mustFix` issues (DANGLING LINK / ASYMMETRY /
 * ERROR) — the change cannot land until they're resolved. The payload
 * carries the structured report so the UI / agent can render the items
 * the user must fix without re-running the validator.
 */
export class ValidationFailedError extends WorkflowDomainError {
  readonly validation: ValidationReport;
  constructor(report: ValidationReport) {
    super(
      `Cannot commit — knowledge graph has ${report.mustFix.length} unresolved issue(s).`,
      422,
      {
        validation: {
          ok: report.ok,
          mustFix: report.mustFix,
          warnings: report.warnings,
        },
      },
    );
    this.name = 'ValidationFailedError';
    this.validation = report;
  }
}

/**
 * Method exists on the workflow interface but has no backing implementation
 * yet. 501 so the frontend can light up "coming soon" affordances without
 * confusing them with 5xx infra failures. `feature` is the workflow method
 * name; clients switch on it to render targeted copy.
 */
export class NotImplementedWorkflowError extends WorkflowDomainError {
  readonly kind = 'not-implemented' as const;
  constructor(readonly feature: string) {
    super(
      `Workflow feature "${feature}" is not yet implemented in this build.`,
      501,
      { kind: 'not-implemented', feature },
    );
    this.name = 'NotImplementedWorkflowError';
  }
}

/**
 * Attempting to reconcile two branches (opening a change request, refreshing
 * one from target, or executing a merge) hit conflicts that the workflow
 * cannot auto-resolve. The structured payload carries the list of
 * conflicting paths so the frontend / agent can route into the resolution
 * flow without a second round-trip.
 *
 * 409 because the conflict is a precondition the caller has to clear (by
 * resolving + committing on the source branch) before the operation can
 * succeed — same semantics git itself uses for merge conflicts.
 */
export class ChangeRequestConflictsError extends WorkflowDomainError {
  readonly kind = 'change-request-conflicts' as const;
  constructor(
    readonly sourceBranch: string,
    readonly targetBranch: string,
    readonly conflictedPaths: string[],
  ) {
    const list = conflictedPaths.join(', ');
    super(
      `Conflicts merging "${targetBranch}" into "${sourceBranch}". ` +
        `${conflictedPaths.length} file(s): ${list}. Resolve on "${sourceBranch}" and try again.`,
      409,
      {
        kind: 'change-request-conflicts',
        sourceBranch,
        targetBranch,
        conflictedPaths,
      },
    );
    this.name = 'ChangeRequestConflictsError';
  }
}

/**
 * Caller tried to open a change request for a `(source, target)` pair that
 * already has one open. Spec rule: A→B blocks A→B (B→A is allowed). Carries
 * the existing CR number so the UI / agent can deep-link to it instead of
 * trying to recover.
 */
export class DuplicateChangeRequestError extends WorkflowDomainError {
  readonly kind = 'duplicate-change-request' as const;
  constructor(
    readonly sourceBranch: string,
    readonly targetBranch: string,
    readonly existingNumber: number,
  ) {
    super(
      `An open change request already exists from "${sourceBranch}" to "${targetBranch}" (#${existingNumber}).`,
      409,
      {
        kind: 'duplicate-change-request',
        sourceBranch,
        targetBranch,
        existingNumber,
      },
    );
    this.name = 'DuplicateChangeRequestError';
  }
}

/**
 * Raised when a merge must neutralise a CR's `roles.yaml` change (restore the
 * base branch's version on the source branch) but that preservation write fails.
 * `roles.yaml` decides admin membership and is mutable ONLY via the admin Roles
 * & Members surface — a CR must never carry a roles.yaml change across a merge,
 * so if we cannot guarantee the base version is preserved we abort the merge
 * rather than risk landing the CR's version on a protected branch. 502: the
 * failure is an internal git/push hiccup, not the caller's fault.
 */
export class RolesYamlPreservationError extends WorkflowDomainError {
  readonly kind = 'roles-yaml-preservation-failed' as const;
  /**
   * The underlying git/push failure. Kept OFF the client-facing message (which
   * stays generic for the 502) so raw git internals / paths don't leak to the
   * caller — log this server-side for diagnostics instead.
   */
  readonly detail: string;
  constructor(reason: string) {
    super(
      'Could not preserve the official roles.yaml while merging — merge aborted so no roles.yaml change can ride in.',
      502,
      { kind: 'roles-yaml-preservation-failed' },
    );
    this.name = 'RolesYamlPreservationError';
    this.detail = reason;
  }
}
