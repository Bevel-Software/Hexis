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
import { sanitizedPath } from './printable.js';

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
    /**
     * Why the push did not land. `diverged`: the remote moved and the
     * cooperative rebase could not reconcile. `refused`: the host turned the
     * push away for any other reason (an outage, credentials, a dropped
     * connection) — nothing to reconcile, the next push of the branch carries
     * the commits. The opening clause is the same either way.
     */
    readonly cause: 'diverged' | 'refused' = 'diverged',
  ) {
    super(
      `Saved locally on "${branch}" but couldn't share with the team automatically — ` +
        (cause === 'refused'
          ? `the repository host refused the push. The next save on this branch shares it.`
          : `the remote diverged on "${path}" and the cooperative rebase couldn't reconcile. ` +
            `The agent will resolve this.`),
      409,
      // The two details are raw git output — stderr can quote a credentialed
      // URL, server paths, the host's own error page. They stay on the error
      // for the server log and never enter the payload the browser receives.
      { kind: 'push-needs-resolution', branch, path },
    );
    this.name = 'PushNeedsAgentResolutionError';
  }
}

/**
 * The repository host refused to delete a branch (an outage, a protection
 * rule, a dropped connection). Deletion pushes FIRST and deletes locally only
 * once the host agreed, so the branch is still there — locally and remotely —
 * and the person can try again later. Unlike a refused write there is nothing
 * to keep "saved locally": a deleted branch has no later push to carry it.
 *
 * `detail` is the raw git failure, for the server log only; it never enters
 * the message or the payload.
 */
export class BranchDeleteRefusedError extends WorkflowDomainError {
  readonly kind = 'branch-delete-refused' as const;
  constructor(readonly branchName: string, readonly detail: string) {
    super(
      `The repository host refused to delete "${branchName}"; it is still there. Try again later.`,
      409,
      { kind: 'branch-delete-refused', branchName },
    );
    this.name = 'BranchDeleteRefusedError';
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
 * The one sentence a branch-less call is answered with. Names the input and
 * what to pass, and carries NO stringified value of what was actually
 * received: the whole point of this refusal is that the caller sent nothing,
 * and echoing `undefined` back at them is how the branch "undefined" got
 * invented in the first place.
 */
export const BRANCH_REQUIRED_MESSAGE =
  '`branch` is required: pass the branch (draft) you are working on.';

/**
 * The caller named no branch — the input is missing, empty, not a string, or
 * one of the stringified absent values (`"undefined"` / `"null"`) that a
 * client produces by interpolating a variable it never set.
 *
 * Refused, never defaulted. A knowledge-base tool's workspace is NEVER implied
 * by the credential (identity-only) — it always comes from this argument — so
 * falling back to the deployment's default branch would make an omitted
 * argument silently act on the protected branch. And it is refused HERE, at
 * the boundary, because everything downstream treats the value as a real
 * branch name: `workspaceIdForBranch` would turn it into a workspace directory
 * literally named `undefined`, and the clone of that "branch" would fail with
 * a story about a branch that never existed.
 *
 * 400 with kind `branch-required`, so a client tells it apart from the 404
 * (no such branch) and the 410 (the branch was deleted) without reading prose.
 */
export class BranchRequiredError extends WorkflowDomainError {
  readonly kind = 'branch-required' as const;
  constructor() {
    super(BRANCH_REQUIRED_MESSAGE, 400, { kind: 'branch-required' });
    this.name = 'BranchRequiredError';
  }
}

/**
 * The stringified absent values. Both are syntactically valid git branch
 * names, so the shape validator (`assertValidBranchName`) accepts them
 * happily — accepting one is exactly the bug this guard exists for. They are
 * refused BY NAME, which is why this check cannot be folded into the shape
 * check however tempting that looks.
 */
const STRINGIFIED_ABSENT_VALUES = new Set(['undefined', 'null']);

/**
 * Refuse a call that names no branch, before anything downstream can turn the
 * missing value into a directory name, a clone attempt or a log line.
 *
 * Deliberately NOT a shape check: a well-formed name this platform has never
 * seen is a 404 the caller can act on, and a malformed one is a
 * `BranchNameError` from the canonical validator. This answers only "you sent
 * nothing", which is the one case where naming the branch back is impossible.
 */
export function assertBranchProvided(branch: unknown): asserts branch is string {
  if (typeof branch !== 'string' || branch.length === 0) throw new BranchRequiredError();
  if (STRINGIFIED_ABSENT_VALUES.has(branch)) throw new BranchRequiredError();
}

/**
 * The platform has never heard of this branch: nothing it has cloned, and
 * nothing any listing of origin's branches has mentioned. Distinct from
 * `RemoteBranchGoneError`, which is the SAME git failure about a branch the
 * platform did know — and answering that for a name nobody ever pushed told
 * the reader their typo "no longer exists on the remote", which implies it
 * once did. 404, and the message names the branch and nothing else: no git
 * output, no remote URL.
 */
export class BranchNotFoundError extends WorkflowDomainError {
  readonly kind = 'branch-not-found' as const;
  constructor(readonly branch: string) {
    super(`There is no branch named ${branch}.`, 404, {
      kind: 'branch-not-found',
      branch,
    });
    this.name = 'BranchNotFoundError';
  }
}

/**
 * The clone's branch no longer exists on origin: the fetch that refreshes
 * `refs/remotes/origin/<branch>` found no such ref. Distinct from an
 * unreachable remote — the host answered, and the answer was "gone" — so a
 * caller can treat the clone as stale rather than the sync as failed. 410.
 *
 * Only for a branch the platform KNEW: a clone of it, or a listing that named
 * it. For a name it has never heard of, the same git failure is a
 * `BranchNotFoundError` — see `WorkspaceService.hasHeardOfBranch`. A sync
 * always has the clone in hand, so it is always this one.
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
 * Whether a failed clone or fetch failed because origin has no such branch, as
 * opposed to being unreachable or refusing the credential. Git's wording for
 * the two shapes: `Remote branch <x> not found in upstream origin` (clone) and
 * `couldn't find remote ref refs/heads/<x>` (fetch). The ONE classifier for
 * this fact — the workspace bootstrap and the git layer both consult it, so
 * a wording learned by one is learned by both.
 */
export function isMissingRemoteBranchFailure(message: string): boolean {
  return /Remote branch .* not found in upstream|couldn't find remote ref/i.test(message);
}

/**
 * The caller named a path that resolves outside the workspace it was asked
 * for. In practice that means an absolute path: a `..` climb is refused one
 * step earlier, as an invalid path, by the same validator the file verbs run
 * first.
 *
 * 403 carrying the exact message the file verbs answer, because
 * `WorkspaceService.assertWithinWorkspace` throws a bare `Error` with this
 * text and `workspace.routes.sendError` maps that text to 403. The lock
 * service raises this instead of a bare `Error`, because `toHttpError` on the
 * workflow routes reads the status off the class and would otherwise call it
 * a 500. Both surfaces then answer identically for the same input. See
 * `canonicalFileIdentity`.
 */
export class PathTraversalError extends WorkflowDomainError {
  readonly kind = 'path-traversal' as const;
  constructor() {
    super('Path traversal detected', 403, { kind: 'path-traversal' });
    this.name = 'PathTraversalError';
  }
}

/**
 * The caller named a path inside the repository's internal git folder: any
 * `.git` segment, in any case, however it was spelled or reached (see
 * `shared/git-internals.ts`). One message for every such path, whether or not
 * anything is there, so the refusal is not an existence oracle.
 */
export const GIT_INTERNALS_MESSAGE = "That path is inside the repository's internal git data and is not available.";

export class GitInternalsError extends WorkflowDomainError {
  readonly kind = 'git-internals' as const;
  constructor() {
    super(GIT_INTERNALS_MESSAGE, 403, { kind: 'git-internals' });
    this.name = 'GitInternalsError';
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
 * The commit an applied change request records is in the clone but is NOT
 * that request's own merge commit — no second parent (not a merge), no first
 * parent (a root commit), or a message that does not name the request. A
 * validation failure like the one above, told apart
 * because it never mends: a reader may remember it, where a commit the clone
 * merely does not hold yet must be asked for again after the next fetch.
 */
export class AppliedChangeMismatchError extends WorkflowValidationError {
  constructor(message: string, payload?: Record<string, unknown>) {
    super(message, payload);
    this.name = 'AppliedChangeMismatchError';
  }
}

/**
 * The next step a missing path always offers, in one sentence.
 *
 * Lives HERE, the layer with no module imports, because both surfaces that
 * answer a missing path need it and they sit on opposite sides of a module
 * boundary: this class (raised by services, rendered by the HTTP routes) and
 * `modules/workspace/not-found.ts` (the file tools), which re-exports the
 * constant under its own name. One sentence, written once, so the two cannot
 * drift apart.
 */
export const NOT_FOUND_NEXT_STEP = 'Check the path with list_files.';

/**
 * Nothing is at the path the caller named.
 *
 * Raised by a SERVICE that probed the path itself, where the file tools' own
 * `not-found` helper (modules/workspace/not-found.ts) cannot reach: the zip
 * reader, for instance, answers "ADM-ZIP: Invalid filename" for a missing
 * archive, which is not a filesystem error at all and would otherwise be
 * dressed up as an unreadable archive. The helper recognises this class and
 * the raw `ENOENT`/`ENOTDIR` shapes alike, so both end as the one 404.
 *
 * 404 with a `not_found` kind and the requested path, which is also what the
 * HTTP routes answer — a path that is not there gets one answer whichever
 * surface asked. The MESSAGE AND THE PAYLOAD ARE BUILT HERE, not by whoever
 * catches it, because not every surface catches it: the tools pass through
 * `orDeclaredNotFound`, which re-renders the same three parts, but
 * `POST /workspace/:id/unzip` sends this error straight to `domainErrorBody`.
 * Sanitizing the path and appending the next step in the constructor is what
 * makes those two answers the same answer.
 */
export class PathNotFoundError extends WorkflowDomainError {
  readonly kind = 'not_found' as const;
  /** The requested path, sanitized — never the path on disk. */
  readonly path: string;
  constructor(path: string) {
    const safe = sanitizedPath(path);
    super(
      `There is no file or directory at "${safe}" in this workspace. ${NOT_FOUND_NEXT_STEP}`,
      404,
      { kind: 'not_found', path: safe },
    );
    this.name = 'PathNotFoundError';
    this.path = safe;
  }
}

/**
 * The one sentence every read of a past save answers when that save is not in
 * the history of the branch being viewed.
 *
 * Written once, here, because four surfaces have to give the same answer: the
 * bytes route (`?ref=`), the patch route (`show-file`), the before/after
 * contents route (`file-at-change`), and anything later that serves a file at
 * a commit. A save the history panel listed came off `git log` on this
 * workspace's own branch, so it can never be refused this way — what this
 * refuses is a sha from someone else's branch, or one that was invented.
 */
export const VERSION_NOT_ON_BRANCH_MESSAGE =
  "This version is not in this file's history on this branch.";

/**
 * The caller named a save that is not an ancestor of the branch this
 * workspace has checked out.
 *
 * 404, and DELIBERATELY the same 404 for a sha that exists on another branch
 * as for one that exists nowhere: telling the two apart would turn the route
 * into an oracle for "does this commit exist in the repository", which is
 * exactly the reading a branch-scoped rule exists to prevent.
 */
export class VersionNotOnBranchError extends WorkflowDomainError {
  readonly kind = 'version-not-on-branch' as const;
  constructor() {
    super(VERSION_NOT_ON_BRANCH_MESSAGE, 404, { kind: 'version-not-on-branch' });
    this.name = 'VersionNotOnBranchError';
  }
}

/**
 * An archive the caller uploaded that the zip reader cannot open. 422, not
 * 400: the request is well-formed and the path is fine — the BYTES are not a
 * readable zip, which is the caller's to fix but not their spelling's.
 *
 * A type, because the route used to recognise this by the `Could not read zip
 * file` prefix its message happens to start with, and a reworded message
 * would silently have turned it into a 500.
 */
export class UnreadableArchiveError extends WorkflowDomainError {
  constructor(reason: string) {
    super(`Could not read zip file: ${reason}`, 422, { kind: 'unreadable-archive' });
    this.name = 'UnreadableArchiveError';
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
 * A direct branch merge was asked to do what an open change request is
 * waiting for a person to do: merge `sourceBranch` into `targetBranch`.
 * Carries the request's number so the caller can point the person at it.
 */
export class OpenChangeRequestBlocksMergeError extends WorkflowDomainError {
  readonly kind = 'open-change-request-blocks-merge' as const;
  constructor(
    readonly sourceBranch: string,
    readonly targetBranch: string,
    readonly number: number,
  ) {
    super(
      `Change request #${number} proposes merging "${sourceBranch}" into "${targetBranch}" and is still open. ` +
        `A change request is merged by a person: ask the user to review #${number} in the app.`,
      409,
      { kind: 'open-change-request-blocks-merge', sourceBranch, targetBranch, number },
    );
    this.name = 'OpenChangeRequestBlocksMergeError';
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
