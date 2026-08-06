/**
 * Workflow facade — the only thing app callers (routes, agent tools, tests)
 * should reach for. Today it delegates to the existing git / PR /
 * review-workflow services; over PLAN steps 2–5 the implementations migrate
 * here directly and the underlying services either disappear or move
 * underneath this module.
 *
 * The facade does no caching, no validation, no policy of its own — it
 * exists to:
 *   1. Lock in the workflow vocabulary on the consumer side.
 *   2. Concentrate every call into git/PR/review-workflow into one place
 *      so the agent prompt can stop knowing about `git` / `gh`.
 *
 * Methods backed by services that don't exist yet (locks, openChangeRequest,
 * updateFromTarget) throw `NotImplementedWorkflowError`. The interface
 * defines them so frontend / agent code can wire to the final surface while
 * those backings land.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AcquireLockResult,
  AuthUser,
  Branch,
  BranchWorkspaceStatus,
  CancelChangeRequestResult,
  Change,
  ChangeInput,
  ChangeRequest,
  ChangeRequestComment,
  ChangeRequestDetail,
  ChangeRequestState,
  ChangedFile,
  FileApproval,
  FileLock,
  IWorkflowService,
  MergeChangeRequestOutcome,
  OpenChangeRequestInput,
  PostChangeRequestCommentInput,
} from '@bevel-software/platform-shared';
import { isProtectedBranch } from '@bevel-software/platform-shared';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { changeRequests } from '../database/schema.js';
import type { GitService } from './git/git.service.js';
import type { PullRequestService } from './git/pull-request.service.js';
import type { IReviewWorkflowService } from './review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { workspaceIdForBranch } from '../workspace/workspace.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { FileLockService } from './file-lock.service.js';
import { PendingCommitsService } from './pending-commits.service.js';
import type { WorkflowEventBus } from './event-bus.js';
import type { FileChangeNotifier } from './file-change-notifier.js';
import { WorkflowHooks } from './workflow-hooks.js';
import { WorkspaceMutex } from './git/mutex.js';
import { hashEmail } from '../../shared/hash-email.js';
import {
  ChangeRequestConflictsError,
  DuplicateChangeRequestError,
  RolesYamlPreservationError,
  PullRebaseConflictError,
  PushNeedsAgentResolutionError,
  WorkflowValidationError,
} from './workflow.errors.js';
import { RECOVERY_BOT_EMAIL, RECOVERY_BOT_NAME } from './recovery-bot.js';
import { AccessDeniedError } from '../access/access-errors.js';

const execFileAsync = promisify(execFile);

/** The partial unique index that enforces one OPEN change request per (source, target) pair. */
const OPEN_PAIR_CONSTRAINT = 'change_requests_open_pair_unq';

/**
 * True only for a Postgres unique violation (23505) on the open-CR-per-pair
 * index. `change_requests` also carries `change_requests_number_unq` on its
 * identity column, so we match the constraint NAME — a violation on any other
 * unique index is a real integrity problem that must not be reported as a
 * duplicate/open-close race.
 */
function isOpenPairViolation(err: unknown): boolean {
  // node-postgres puts `code` + `constraint` on the driver error; Drizzle
  // sometimes wraps that error in `.cause`, so unwrap one level and check both.
  const fieldOf = (e: unknown, key: 'code' | 'constraint' | 'message'): unknown =>
    typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[key] : undefined;
  const cause = typeof err === 'object' && err !== null ? (err as { cause?: unknown }).cause : undefined;
  const is23505 = fieldOf(err, 'code') === '23505' || fieldOf(cause, 'code') === '23505';
  if (!is23505) return false;
  // Prefer the structured `constraint` name; some pg drivers omit it, so fall
  // back to sniffing the named index out of the message (same approach as
  // db-routine.service's isUniqueViolation).
  const constraint = fieldOf(err, 'constraint') ?? fieldOf(cause, 'constraint');
  if (constraint === OPEN_PAIR_CONSTRAINT) return true;
  const message = fieldOf(err, 'message') ?? fieldOf(cause, 'message');
  return typeof message === 'string' && message.includes(OPEN_PAIR_CONSTRAINT);
}

/** Redact the shared GitHub token from any error string before surfacing it. */
function redactTokens(msg: string): string {
  const tokens = [process.env.GITHUB_TOKEN, process.env.GH_TOKEN].filter(
    (t): t is string => !!t && t.length > 0,
  );
  return tokens.reduce((m, t) => m.replaceAll(t, '***'), msg);
}

/**
 * Cap on how many changed paths the `## Affected owners` CR-body block lists
 * individually. The block is passed to `gh pr create --body`, an argv string,
 * so an uncapped per-path list on a large changeset (hundreds/thousands of
 * files) makes the whole command exceed the OS arg limit and fail with E2BIG.
 */
export const MAX_AFFECTED_PATHS_LISTED = 50;

type EligibleWriters = Map<
  string,
  { roles: string[]; users: { name: string; email: string }[] }
>;

const formatWriter = (u: { name: string; email: string }): string =>
  u.name ? `${u.name} <${u.email}>` : u.email;

/**
 * Render the `## Affected owners` block for the CR body: eligible approvers per
 * changed path, but only the first `maxListed` paths are listed individually;
 * the overflow is collapsed into a single deduped summary of every eligible
 * approver across the change. This keeps the body bounded regardless of how
 * many files the change touches (see {@link MAX_AFFECTED_PATHS_LISTED}).
 * Returns '' when no path has resolvable eligibility.
 */
export function formatAffectedOwnersBlock(
  paths: string[],
  resolved: EligibleWriters,
  maxListed: number = MAX_AFFECTED_PATHS_LISTED,
): string {
  const listed: string[] = [];
  const allRoles = new Set<string>();
  const allUsers = new Map<string, string>(); // email -> display, deduped
  let eligible = 0;
  for (const p of paths) {
    const info = resolved.get(p);
    if (!info) continue;
    const parts: string[] = [];
    if (info.roles.length > 0) {
      info.roles.forEach((r) => allRoles.add(r));
      parts.push(info.roles.join(', '));
    }
    if (info.users.length > 0) {
      info.users.forEach((u) => allUsers.set(u.email, formatWriter(u)));
      parts.push(info.users.map(formatWriter).join(', '));
    }
    if (parts.length === 0) continue;
    eligible++;
    if (listed.length < maxListed) listed.push(`- \`${p}\` — ${parts.join('; ')}`);
  }
  if (eligible === 0) return '';

  const out = ['## Affected owners', '', ...listed];
  if (eligible > listed.length) {
    const summary = [
      allRoles.size > 0 ? [...allRoles].sort().join(', ') : '',
      allUsers.size > 0 ? [...allUsers.values()].sort().join(', ') : '',
    ].filter((s) => s.length > 0);
    out.push(
      '',
      `…and ${eligible - listed.length} more changed path(s). ` +
        `All eligible approvers across this change: ${summary.join('; ')}`,
    );
  }
  return out.join('\n');
}

export class WorkflowService implements IWorkflowService {
  /**
   * Concrete `PullRequestService` (not the interface) so the facade can call
   * `invalidateDetailCache` after a mutation lands — the legacy routes do
   * this inline, and the workflow facade absorbs that responsibility so its
   * own routes stay free of cache plumbing. Replaceable later when the PR
   * detail cache moves into the workflow module proper (PLAN step 5).
   *
   * `db` + `workspaceService` + `kbDirName` back `openChangeRequest`, which
   * inserts a change_requests row and runs the local auto-merge — no provider
   * PR API, so the KB can live on any git host.
   */
  /**
   * Concrete `GitService` (not the interface) so the facade can reach
   * `mergeFromOrigin` — the local auto-merge primitive the workflow needs
   * for `openChangeRequest` + `updateFromTarget` (PLAN §1). The interface
   * intentionally doesn't surface that method because it's an internal
   * implementation detail of the workflow auto-merge story; nothing outside
   * the facade should call it directly.
   */
  constructor(
    private readonly db: Database,
    private readonly git: GitService,
    private readonly prs: PullRequestService,
    private readonly reviewWorkflow: IReviewWorkflowService,
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly fileLocks: FileLockService,
    /**
     * Background commit queue. `releaseLock` enqueues a row instead of
     * committing inline; the `PendingCommitsWorker` drains the queue and
     * runs commit + push out of band. This keeps git's latency and
     * failure modes entirely off the user-facing lock release path.
     * See `lock-decoupling-plan.md` for the full design.
     */
    private readonly pendingCommits: PendingCommitsService,
    private readonly kbDirName: string,
    /**
     * Event bus that fans state changes out to connected SSE sessions.
     * Optional so test harnesses / minimal boots can omit it — emits
     * become no-ops in that case (we null-guard each call). In a real
     * boot the composition root always wires one.
     */
    private readonly events?: WorkflowEventBus,
    /**
     * In-process post-commit hook (distinct from the SSE `events` bus): fires
     * after a file's change is committed + pushed so backend services (catalog
     * invalidation, id-repair) react without the per-file TTL wait. Optional,
     * like `events`.
     */
    private readonly fileChanges?: FileChangeNotifier,
    /**
     * Workflow lifecycle-hook registry (see `workflow-hooks.ts`). PUBLIC so
     * the composition root registers module-owned behavior against it
     * (`core.workflowService.hooks.onCommitValidation(…)` /
     * `.onPreWrite(…)`) after `createCoreServices` returns. The composition
     * root passes the SAME instance `GitService` and the session-ontology
     * gate consult; the default keeps test constructions (which don't
     * exercise hooks) unchanged.
     */
    public readonly hooks: WorkflowHooks = new WorkflowHooks(),
  ) {}

  // ── Branches ──────────────────────────────────────────────────────────────

  /**
   * One-shot guard so the orphan-workspace sweep fires once per process,
   * not on every listBranches call. The sweep runs in the background
   * after the first list returns — failures are swallowed and logged.
   */
  private orphanSweepStarted = false;

  async listBranches(workspaceId: string, opts?: { freshFetch?: boolean }): Promise<Branch[]> {
    const branches = await this.git.listBranches(workspaceId, opts);
    if (!this.orphanSweepStarted) {
      this.orphanSweepStarted = true;
      // Fire-and-forget. The sweep is best-effort cleanup of dirs whose
      // branches no longer exist on origin; nothing else depends on it
      // completing inside the listBranches window.
      this.workspaceService
        .sweepOrphanedWorkspaces(branches.map((b) => b.name))
        .then(({ removed }) => {
          if (removed.length > 0) {
            console.log(`[workflow] swept ${removed.length} orphaned workspace(s):`, removed);
          }
        })
        .catch((err) => {
          console.warn('[workflow] orphan workspace sweep failed:', err);
        });
    }
    return branches;
  }

  createBranch(workspaceId: string, name: string, fromBase?: string): Promise<Branch> {
    return this.git.createBranch(workspaceId, name, fromBase);
  }

  /**
   * Serialises everything that decides a branch's fate — opening a change
   * request from it, deleting it, retiring it after a merge — by branch
   * name. Without it, `retireMergedSourceBranch`'s check-then-delete could
   * interleave with `openChangeRequest`'s check-then-insert (which spans a
   * multi-second auto-merge and push) and delete a branch a request was
   * being opened from. In-process only, which matches the deployment model:
   * one server process owns the workspaces directory.
   */
  private readonly branchLifecycle = new WorkspaceMutex();

  async deleteBranch(
    workspaceId: string,
    name: string,
    user: AuthUser,
    opts?: { onlyIfNoRemote?: boolean; systemCleanup?: boolean },
  ): Promise<void> {
    return this.branchLifecycle.run(`branch:${name}`, async () => {
      // A branch backing an OPEN change request is load-bearing: deleting it
      // strands the request (and, in the propose flow's reset-on-reuse, would
      // let one tab wipe the branch another tab just proposed from). The
      // request has to be withdrawn or declined first. `systemCleanup` does
      // its own open-request check under this same lock, and the legacy
      // `onlyIfNoRemote` prune only fires when origin no longer has the ref.
      if (!opts?.systemCleanup && !opts?.onlyIfNoRemote) {
        const open = await this.db
          .select({ number: changeRequests.number })
          .from(changeRequests)
          .where(
            and(eq(changeRequests.sourceBranch, name), eq(changeRequests.state, 'open')),
          )
          .limit(1);
        if (open.length > 0) {
          throw new WorkflowValidationError(
            `Branch "${name}" has an open change request (#${open[0].number}) — withdraw or decline it before deleting the branch.`,
          );
        }
      }
      await this.deleteBranchUnlocked(workspaceId, name, user, opts);
    });
  }

  /** The deletion itself — callers must hold the branch-lifecycle lock. */
  private async deleteBranchUnlocked(
    workspaceId: string,
    name: string,
    user: AuthUser,
    opts?: { onlyIfNoRemote?: boolean; systemCleanup?: boolean },
  ): Promise<void> {
    await this.git.deleteBranch(workspaceId, name, user, opts);
    // Retire the deleted branch's own workspace clone, best-effort. A stale
    // clone left on disk would be silently REUSED if the branch name is ever
    // recreated (the workspace bootstrap short-circuits on an existing
    // `.git`), resurrecting the deleted branch's content under a fresh ref.
    try {
      const branchWorkspaceId = workspaceIdForBranch(name);
      if (await this.workspaceService.hasBootstrappedWorkspace(branchWorkspaceId)) {
        await this.workspaceService.deleteWorkspace(branchWorkspaceId);
      }
    } catch (err) {
      console.warn(
        `[workflow] could not retire workspace clone of deleted branch "${name}":`,
        err,
      );
    }
  }

  // No `switchBranch` here on purpose. Under the per-branch workspace model,
  // switching branches is a frontend navigation that triggers a workspace
  // bootstrap (cloning the new branch into its own dir). The backend no
  // longer exposes a "checkout this branch on the source workspace's clone"
  // operation, which was the only place the legacy DirtyWorkingTreeError
  // could surface as a user-facing 409.

  // `forkCurrentToDraft` removed (see IWorkflowService): per-branch workspaces
  // make the dirty-tree-carry-along escape hatch impossible by construction.

  branchStatus(workspaceId: string): Promise<BranchWorkspaceStatus> {
    return this.git.status(workspaceId);
  }

  // `discardWorkingChanges` removed: under save=share there's nothing dirty
  // to discard.

  shareCurrentBranch(workspaceId: string, user: AuthUser): Promise<void> {
    return this.git.push(workspaceId, user);
  }

  refreshRemotes(workspaceId: string): Promise<void> {
    return this.git.fetch(workspaceId);
  }

  async updateFromRemote(workspaceId: string, user?: AuthUser): Promise<void> {
    try {
      await this.git.pull(workspaceId);
    } catch (err) {
      if (err instanceof PullRebaseConflictError) {
        await this.queuePullConflictRecovery(workspaceId, err, user);
      }
      throw err;
    }
  }

  /**
   * A pull hit a rebase conflict — the workspace carries local commits that
   * conflict with origin, a state that never resolves on its own (every
   * retry pull re-hits it, and the local commits are saved-but-unshared
   * content violating save=share). Queue ONE pending-commits row for it so
   * the worker's existing retry → recovery-agent → escalate ladder takes
   * over in the background.
   *
   * `enqueueIfAbsent` (not `enqueue`): sync attempts can fire repeatedly
   * (every branch focus / merge), and a fresh `enqueue` would reset the
   * existing row's retry counters each time — starving the ladder so the
   * recovery agent never spawns. It also refuses to resurrect a
   * `needs_attention` row: once the ladder has escalated to a human, more
   * agent runs on the same divergence are just a loop.
   *
   * One row, smallest conflicted path as the representative: the recovery
   * agent's job is "bring the BRANCH into a pushable state", so one ladder
   * per divergence — not one per conflicted file, which would multiply
   * agent runs for a single underlying conflict. Sorted so the choice is
   * stable across retries regardless of how the caller ordered the paths —
   * a shifting representative would slip past `enqueueIfAbsent`'s
   * per-(workspace, branch, path) dedup and start a second ladder.
   *
   * Best-effort by design — the caller is already surfacing the conflict
   * error; a queue hiccup must not mask it.
   */
  private async queuePullConflictRecovery(
    workspaceId: string,
    err: PullRebaseConflictError,
    user?: AuthUser,
  ): Promise<void> {
    try {
      const queued = await this.pendingCommits.enqueueIfAbsent({
        workspaceId,
        branch: err.branch,
        path: [...err.conflictedPaths].sort()[0],
        authorEmail: user?.email ?? RECOVERY_BOT_EMAIL,
        authorName: user?.name ?? RECOVERY_BOT_NAME,
      });
      if (queued) {
        console.warn(
          `[workflow] pull conflict on ws=${workspaceId} branch=${err.branch} (${err.conflictedPaths.join(', ')}) — queued background recovery`,
        );
      }
    } catch (queueErr) {
      console.error(
        `[workflow] failed to queue pull-conflict recovery for ws=${workspaceId}:`,
        queueErr instanceof Error ? queueErr.message : queueErr,
      );
    }
  }

  resetToRemote(workspaceId: string, branch: string): Promise<void> {
    return this.git.resetToRemote(workspaceId, branch);
  }

  resolveForkBase(workspaceId: string, branch: string): Promise<string | null> {
    return this.git.resolveForkBase(workspaceId, branch);
  }

  countCommitsAhead(workspaceId: string, branch: string, baseBranch: string): Promise<number> {
    return this.git.countCommitsAhead(workspaceId, branch, baseBranch);
  }

  listPendingChangePaths(workspaceId: string): Promise<string[]> {
    return this.git.pendingChanges(workspaceId);
  }

  // `listWorkingChanges` + `diffFileInWorking` removed: working-tree dirty
  // state isn't a meaningful surface under save=share.

  // ── Changes ───────────────────────────────────────────────────────────────

  commitChange(workspaceId: string, user: AuthUser, input: ChangeInput): Promise<Change> {
    return this.git.commit(workspaceId, user, input);
  }

  /**
   * Atomic multi-file commit + push — commits whatever the caller has already
   * written to the working tree as ONE change attributed to `user`, then pushes
   * so collaborators on the branch see it (same commit-then-push shape as the
   * autosave path). Returns null if the tree is clean (no-op). Behind the bulk
   * node-upload flow and the role-rename rewrite (via `LockingFilesystem`) — both
   * write their files first, then call this. Does NOT write content itself; the
   * caller owns the disk write (and any content validation).
   */
  async commitChanges(
    workspaceId: string,
    user: AuthUser,
    summary: string,
  ): Promise<Change | null> {
    const change = await this.git.commitChanges(workspaceId, user, summary);
    // Same recovery as the per-file queue: a bare push here could strand the
    // just-made local commit (committed but never shared — breaking save=share)
    // on any non-fast-forward race. Pull-rebase + retry recovers the common
    // case; a genuine failure still throws the typed agent-handoff error, with
    // the commit intact for the recovery flow — exactly like `runPendingCommit`.
    // Workspace id IS the encoded branch name (see workspace.service.ts).
    if (change) {
      await this.pushWithRecovery(workspaceId, decodeURIComponent(workspaceId), '(batch)', user);
    }
    return change;
  }

  listChangesForFile(workspaceId: string, path: string, limit?: number): Promise<Change[]> {
    return this.git.logForFile(workspaceId, path, limit);
  }

  revertChange(workspaceId: string, user: AuthUser, sha: string): Promise<Change> {
    return this.git.revertCommit(workspaceId, user, sha);
  }

  compareFile(
    workspaceId: string,
    path: string,
    fromBranch: string,
    toBranch: string,
  ): Promise<string> {
    return this.git.diffFileBetweenBranches(workspaceId, path, fromBranch, toBranch);
  }

  showFileAtChange(workspaceId: string, path: string, sha: string): Promise<string> {
    return this.git.diffFileAtCommit(workspaceId, path, sha);
  }

  /**
   * Resolve write permission for `targetPath` against the access tree at
   * `HEAD` of `branch`. Throws `AccessDeniedError` on denial with the
   * eligible-writers payload attached. Bootstrap-friendly: when no rules are
   * in force at the ref yet, treats the call as allow (matches the legacy
   * commit-time gate's behavior).
   *
   * Always reads at-ref, never at the working tree, so a user can't broaden
   * their own access by editing `roles.yaml` / `access.md` in the same
   * session.
   */
  private async assertCanWriteAtPath(
    workspaceId: string,
    branch: string,
    userEmail: string,
    targetPath: string,
  ): Promise<void> {
    // The lock route passes workspace-relative paths
    // (`knowledge-base/GTM/.../Foo.md`), but the access model is keyed by
    // *repo-relative* paths — `git ls-tree` runs inside the inner repo dir,
    // so its access.md entries are at `GTM/.../access.md`, not
    // `knowledge-base/GTM/.../access.md`. Without stripping the kbDirName
    // prefix here, the chain walk only ever matches root access.md, which
    // typically only grants Admin → non-admins get 403'd on files their
    // role's nested access.md actually permits. Mirrors the frontend's
    // `useFileAccess` prefix-strip on the way INTO the API.
    const repoRelative = targetPath.startsWith(`${this.kbDirName}/`)
      ? targetPath.slice(this.kbDirName.length + 1)
      : targetPath;
    const result = await this.accessControl.canWriteBatchAtRef(
      workspaceId,
      `HEAD`,
      userEmail,
      [repoRelative],
    );
    if (!result) return; // no config at ref → default-allow (bootstrap)
    if (result.get(repoRelative)) return;
    const eligible = await this.accessControl.eligibleWritersAtRef(
      workspaceId,
      `HEAD`,
      repoRelative,
    );
    throw new AccessDeniedError({
      path: targetPath,
      eligibleRoles: eligible?.roles ?? [],
      eligibleUsers: eligible?.users ?? [],
    });
  }

  // ── File locks ────────────────────────────────────────────────────────────

  async acquireLock(
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
  ): Promise<AcquireLockResult> {
    // **Permission check at lock acquisition, not at commit time.** Under the
    // "disk is the source of truth" rule, once a write has landed on disk we
    // must never reject the commit that publishes it — otherwise we'd be
    // destroying the user's work to satisfy a permission rule that should
    // have been enforced earlier. The earliest correct point is HERE, before
    // the user starts editing: if they can't write the file, they don't get
    // the lock and the editor never opens. Once the lock is in hand, the
    // commit + push pipeline does not re-check (see `commitFile`).
    //
    // **Protected branches only** (mirrors the legacy commit-time gate). On
    // feature/draft branches anyone can write; canonical state changes go
    // through change-request approval, which is where the real security
    // boundary lives. Checking at HEAD (not at the working tree) so a user
    // can't grant themselves access by editing `roles.yaml` in the same
    // session.
    if (isProtectedBranch(branch)) {
      // `assertCanWriteAtPath` throws AccessDeniedError on denial, with the
      // eligible-writers payload so the frontend can render a useful refusal.
      await this.assertCanWriteAtPath(workspaceId, branch, user.email, targetPath);
    }
    const result = await this.fileLocks.acquire(workspaceId, branch, targetPath, user);
    if (result.acquired) {
      console.log(
        `[lock] ACQUIRE ws=${workspaceId} branch=${branch} path=${targetPath} user=${user.id} → acquired`,
      );
      // Only fire on successful acquisition — a contention "false" return
      // means nothing observable changed for other users (someone else
      // already held the lock and still does). Stale-lock takeover is also
      // an acquisition from the perspective of the rest of the UI.
      this.events?.emit({
        kind: 'lock-acquired',
        workspaceId,
        branch,
        path: targetPath,
        holderUserId: user.id,
        holderName: user.name,
      });
    } else {
      console.log(
        `[lock] ACQUIRE ws=${workspaceId} branch=${branch} path=${targetPath} user=${user.id} → contended, held by ${result.lock.holderName} (${result.lock.holderUserId})`,
      );
    }
    return result;
  }

  async heartbeatLock(
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
  ): Promise<FileLock> {
    try {
      const lock = await this.fileLocks.heartbeat(workspaceId, branch, targetPath, user);
      console.log(
        `[lock] HEARTBEAT ws=${workspaceId} branch=${branch} path=${targetPath} user=${user.id} → ok (expires ${lock.expiresAt})`,
      );
      return lock;
    } catch (err) {
      console.warn(
        `[lock] HEARTBEAT ws=${workspaceId} branch=${branch} path=${targetPath} user=${user.id} → FAIL ${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }
  }

  /**
   * Commit the lock-held file as a change *without* releasing the lock.
   * The autosave checkpoint timer drives this — periodic commits land
   * while the user keeps editing. Refuses when the caller doesn't hold
   * the lock so a stale client can't sneak commits through after their
   * lock expired and another user took over.
   */
  async commitFileWhileLocked(
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
    summary?: string,
  ): Promise<Change | null> {
    const lock = await this.fileLocks.get(workspaceId, branch, targetPath);
    if (!lock || lock.holderUserId !== user.id) {
      throw new WorkflowValidationError(
        `Cannot commit "${targetPath}": you don't hold the lock.`,
        { kind: 'lock-not-held', branch, path: targetPath },
      );
    }
    const change = await this.git.commitFile(workspaceId, user, targetPath, summary);
    // Push the autosave commit so other users on the branch see it
    // without waiting for the eventual lock release. Best-effort, same
    // semantics as the push in `releaseLock`.
    if (change) {
      try {
        await this.git.push(workspaceId, user);
      } catch (err) {
        // Non-fast-forward recovery on the autosave path: try the
        // cooperative `pull --rebase` + retry once. Autosave is
        // best-effort and runs every minute while the lock is held —
        // if cooperative recovery fails (the divergence conflicts with
        // our edit), we DON'T auto-force-push (would destroy teammate
        // commits) and we DON'T surface to the agent yet (the user is
        // still typing — agent involvement would be premature). The
        // eventual `releaseLock` push will hit the same condition and
        // surface a structured `PushNeedsAgentResolutionError` at the
        // moment the user actually closes their edit, which is when
        // the agent should step in.
        const detail = err instanceof Error ? err.message : String(err);
        const looksLikeNonFastForward = /non-fast-forward|rejected|fetch first|updates were rejected/i.test(detail);
        let recovered = false;
        if (looksLikeNonFastForward) {
          try {
            await this.git.pull(workspaceId);
            await this.git.push(workspaceId, user);
            recovered = true;
          } catch (recoveryErr) {
            console.warn(
              '[workflow] autosave cooperative recovery (pull-rebase) failed; leaving the unpushed commit for the next save / releaseLock to surface:',
              recoveryErr instanceof Error ? recoveryErr.message : recoveryErr,
            );
          }
        }
        if (!recovered) {
          console.warn(
            '[workflow] push after autosave commit failed (commit landed locally):',
            detail,
          );
        }
      }
      this.events?.emit({
        kind: 'file-changed',
        workspaceId,
        branch,
        path: targetPath,
        newSha: change.sha,
        byUserId: user.id,
        byUserName: user.name,
      });
    }
    return change;
  }

  /**
   * Release the lock AND commit the file's pending edits as one atomic
   * change. The lock guarantees the file is the only one this caller has
   * been editing, so we use the path-scoped `commitFile` rather than the
   * one-file-per-change-enforcing `commit` — other dirty files in the
   * workspace (e.g. concurrent agent edits on a separate flow) are left
   * alone. Returns `null` when the file had no pending edits, so opening
   * a lock + closing without typing is a clean no-op.
   */
  /**
   * Release a lock the caller holds. **Does NOT commit or push** — those
   * happen out of band in the `PendingCommitsWorker` after this method
   * enqueues a row. The user-visible contract is:
   *
   *   1. Bytes the caller wrote inside the lock are on disk in the shared
   *      per-branch workspace.
   *   2. All same-workspace SSE subscribers see the new bytes via the
   *      `fs-tree-changed` event the upload routes already emit.
   *   3. Git history catches up later, asynchronously.
   *
   * This is the structural fix for the bug class that stranded files on
   * disk whenever the inline commit failed (transient git error, process
   * SIGTERM mid-commit, etc.). See `lock-decoupling-plan.md`.
   *
   * Signature change from the previous shape: no more `summary` /
   * `skipValidator` / `skipPush` / return value. Summary is computed by
   * the worker (`buildDefaultCommitSummary(path)`); validator runs in the
   * worker; push is the worker's job; there's no synchronous `Change`
   * object to return because the commit hasn't happened yet.
   */
  async releaseLock(
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
  ): Promise<void> {
    // Ownership check — the lock service's `release` is idempotent and
    // would silently no-op for a non-holder, but we'd still enqueue a
    // commit attributed to whoever called us. The guard rejects callers
    // who don't actually hold the row so impersonation can't enqueue
    // commits as a third party.
    console.log(
      `[lock] RELEASE start ws=${workspaceId} branch=${branch} path=${targetPath} user=${user.id}`,
    );
    const lock = await this.fileLocks.get(workspaceId, branch, targetPath);
    if (!lock || lock.holderUserId !== user.id) {
      console.warn(
        `[lock] RELEASE refused ws=${workspaceId} branch=${branch} path=${targetPath} user=${user.id} → ${lock ? `held by ${lock.holderName} (${lock.holderUserId})` : 'no lock row'}`,
      );
      throw new WorkflowValidationError(
        `Cannot release lock on "${targetPath}": not held by you (or no longer exists).`,
        { kind: 'lock-not-held', branch, path: targetPath },
      );
    }
    // Order matters here:
    //   1. Drop the lock row. Other sessions can re-acquire immediately.
    //   2. Enqueue the commit. Worker will pick it up on next sweep.
    //   3. Emit `lock-released` SSE.
    //
    // We swap (1) and (2) — enqueue first, drop second — so a process
    // crash between the two leaves the lock held (TTL will release it)
    // rather than dropping the lock without queueing the commit (which
    // would re-introduce the orphan-files class of bug this refactor
    // exists to fix). Worst case: brief over-lock that resolves on TTL.
    await this.pendingCommits.enqueue({
      workspaceId,
      branch,
      path: targetPath,
      authorEmail: user.email,
      authorName: user.name,
    });
    await this.fileLocks.release(workspaceId, branch, targetPath, user);
    console.log(
      `[lock] RELEASE done ws=${workspaceId} branch=${branch} path=${targetPath} user=${user.id} (commit queued for background worker)`,
    );
    // The `file-changed` SSE event used to fire here after the synchronous
    // commit landed, carrying the new sha. Under the queue model the
    // commit hasn't happened yet — the worker emits `file-changed` itself
    // (with the resolved sha) when its commit lands. Same downstream
    // semantics for the frontend, just deferred by the queue's drain
    // latency (typically < 1s).
    this.events?.emit({
      kind: 'lock-released',
      workspaceId,
      branch,
      path: targetPath,
    });
  }

  /**
   * Worker entry point: commit whatever's currently on disk for `path`,
   * then push the branch. This is the body that used to live inline in
   * `releaseLock` — extracted so the background queue runs the same
   * commit + cooperative-push pipeline a synchronous save once did.
   *
   * Throws on commit / push failure so the worker can decide whether to
   * retry, hand off to the recovery agent, or escalate. Emits
   * `file-changed` on success so frontends see the new sha.
   */
  async runPendingCommit(
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
  ): Promise<void> {
    const change = await this.git.commitFile(workspaceId, user, targetPath);
    if (!change) {
      // No-op commit — the path was already clean. Usually a double-enqueue
      // or a save of bytes identical to HEAD, BUT a clean tree does NOT
      // prove there's nothing to share: the autosave path
      // (`commitFileWhileLocked`) commits locally with a best-effort push,
      // and when that push fails the commit stays stranded on the local
      // branch with the tree clean. Treating that as success dropped the
      // row without ever starting the retry → recovery-agent ladder —
      // which is exactly how a diverged workspace ends up stuck forever.
      // So: if the branch is ahead of its remote-tracking ref, push (with
      // the same cooperative recovery, so a conflicting divergence throws
      // and the worker's ladder takes over). Nothing to emit either way —
      // there's no new sha.
      if (await this.git.hasUnpushedCommits(workspaceId)) {
        await this.pushWithRecovery(workspaceId, branch, targetPath, user);
      }
      return;
    }
    await this.pushWithRecovery(workspaceId, branch, targetPath, user);
    this.events?.emit({
      kind: 'file-changed',
      workspaceId,
      branch,
      path: targetPath,
      newSha: change.sha,
      byUserId: user.id,
      byUserName: user.name,
    });
    // Post-commit, post-lock-release: the one chokepoint every single-file write
    // converges on. Backend reactors (catalog invalidation, id-repair) hook here.
    this.fileChanges?.emit({ workspaceId, branch, paths: [targetPath], byUser: user });
  }

  /**
   * Shared implementation of "push, and on non-fast-forward try a
   * cooperative pull-rebase + retry, then hand off to the agent if that
   * still fails." The full rationale lives at the call site in
   * `releaseLock`; this method is the de-duplicated body.
   */
  private async pushWithRecovery(
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
  ): Promise<void> {
    try {
      await this.git.push(workspaceId, user);
    } catch (firstPushErr) {
      const firstDetail = firstPushErr instanceof Error ? firstPushErr.message : String(firstPushErr);
      const looksLikeNonFastForward = /non-fast-forward|rejected|fetch first|updates were rejected/i.test(firstDetail);
      let recovered = false;
      let recoveryDetail = '(cooperative path not attempted)';
      if (looksLikeNonFastForward) {
        try {
          await this.git.pull(workspaceId);
          await this.git.push(workspaceId, user);
          recovered = true;
          console.log(
            `[workflow] non-fast-forward push recovered via pull --rebase for workspace=${workspaceId} branch=${branch} path=${targetPath}`,
          );
        } catch (recoveryErr) {
          recoveryDetail = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
          console.warn(
            `[workflow] cooperative recovery (pull-rebase) failed for workspace=${workspaceId} user=${user.id}; handing off to agent:`,
            recoveryDetail,
          );
        }
      }
      if (!recovered) {
        console.warn(
          `[workflow] push failed for workspace=${workspaceId} user=${user.id}; throwing PushNeedsAgentResolutionError so the frontend can hand off to the agent:`,
          firstDetail,
        );
        throw new PushNeedsAgentResolutionError(branch, targetPath, firstDetail, recoveryDetail);
      }
    }
  }

  /**
   * Failure-path counterpart to `releaseLock`. Skips `commitFile` + push
   * entirely so a half-finished write doesn't accidentally persist its
   * partial state as a committed change. The lock row goes away (so the
   * next caller can edit the file); whatever's on disk stays — the next
   * acquirer will see it. `LockingFilesystem.withLock` calls this from
   * its catch arm so a thrown op (path traversal, validator 422,
   * permission denied) doesn't end up committing.
   */
  async releaseLockNoCommit(
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
  ): Promise<void> {
    // Verify ownership first so the emit only fires when something
    // observable actually changed. `fileLocks.release` silently no-ops
    // when the caller doesn't hold the row (idempotent-by-design), so
    // without this guard a non-holder calling this method would emit
    // `lock-released` and trick every other client into clearing their
    // "Locked by X" banner even though the lock is still held.
    console.log(
      `[lock] RELEASE-NO-COMMIT start ws=${workspaceId} branch=${branch} path=${targetPath} user=${user.id}`,
    );
    const lock = await this.fileLocks.get(workspaceId, branch, targetPath);
    if (!lock || lock.holderUserId !== user.id) {
      console.log(
        `[lock] RELEASE-NO-COMMIT no-op ws=${workspaceId} path=${targetPath} → ${lock ? `held by ${lock.holderName}` : 'no lock row'}`,
      );
      return;
    }
    // **Discard the file's working-tree changes before dropping the lock.**
    // The whole point of this method is "release without committing" —
    // historically that meant "leave partial bytes on disk", but the user-
    // visible consequence was a chronically-dirty working tree that
    // blocked branch switches and could be silently committed by the next
    // acquirer under the wrong author. The system's invariant is now:
    // every release leaves the working tree clean. If we're not
    // committing the bytes, we're throwing them away.
    try {
      await this.git.discardPath(workspaceId, targetPath);
    } catch (err) {
      // Best-effort: a discard failure is logged but doesn't block the
      // lock release. Worst case the working tree stays dirty for one
      // path until the next save on it cleans up.
      console.warn(
        `[workflow] discardPath failed for workspace=${workspaceId} branch=${branch} path=${targetPath}:`,
        err instanceof Error ? err.message : err,
      );
    }
    await this.fileLocks.release(workspaceId, branch, targetPath, user);
    console.log(
      `[lock] RELEASE-NO-COMMIT done ws=${workspaceId} branch=${branch} path=${targetPath} user=${user.id} → discarded + released`,
    );
    this.events?.emit({
      kind: 'lock-released',
      workspaceId,
      branch,
      path: targetPath,
    });
    // The disk just changed (revert / removal). Tell anyone watching so
    // their open tabs refresh to the post-discard state.
    this.events?.emit({
      kind: 'file-changed',
      workspaceId,
      branch,
      path: targetPath,
      newSha: null,
      byUserId: user.id,
      byUserName: user.name,
    });
  }

  getLock(
    workspaceId: string,
    branch: string,
    targetPath: string,
  ): Promise<FileLock | null> {
    return this.fileLocks.get(workspaceId, branch, targetPath);
  }

  // ── Change Requests ───────────────────────────────────────────────────────

  listChangeRequests(opts?: { fresh?: boolean }): Promise<ChangeRequest[]> {
    return this.prs.listOpenPrs(opts);
  }

  listChangeRequestsAuthoredBy(
    emailOrLogin: string,
    opts?: { fresh?: boolean },
  ): Promise<ChangeRequest[]> {
    return this.prs.listPrsAuthoredBy(emailOrLogin, opts);
  }

  listChangeRequestsForUser(
    workspaceId: string,
    email: string,
    opts?: { fresh?: boolean },
  ): Promise<ChangeRequest[]> {
    return this.prs.listPrsForOwnerEmail(workspaceId, email, opts);
  }

  getChangeRequest(number: number): Promise<ChangeRequest | null> {
    return this.prs.getPr(number);
  }

  getChangeRequestDetail(
    number: number,
    opts?: { fresh?: boolean; workspaceId?: string; viewerEmail?: string },
  ): Promise<ChangeRequestDetail | null> {
    return this.prs.getPrDetail(number, opts);
  }

  /**
   * Open a new change request. A change request is a plain `change_requests`
   * row plus the two branches — no provider PR — so any git host works.
   *
   *   1. Validation — non-empty branches, distinct branches, source is not
   *      protected, title present.
   *   2. CR uniqueness — refuse if an open CR already exists for the same
   *      `(source, target)` pair (A→B blocks A→B; B→A is allowed).
   *   3. Auto-merge — `git merge origin/<target>` into `<source>` locally,
   *      so the resulting CR shows the post-merge diff. Conflicts surface
   *      as `ChangeRequestConflictsError` (409 with the conflicting paths)
   *      so the caller (agent or UI) can route into the resolution flow.
   *   4. Push the source branch so the remote carries every commit the CR
   *      will reference, including the auto-merge commit if any.
   *   5. Insert the `change_requests` row (author stored directly — no service
   *      account, so no hidden body marker). The DB-assigned number is the CR id.
   *   6. Re-fetch the full detail via the PR service so the response shape
   *      matches every other CR endpoint.
   */
  async openChangeRequest(
    workspaceId: string,
    user: AuthUser,
    input: OpenChangeRequestInput,
  ): Promise<ChangeRequestDetail> {
    if (!input.sourceBranch) throw new WorkflowValidationError('sourceBranch is required');
    if (!input.targetBranch) throw new WorkflowValidationError('targetBranch is required');
    if (input.sourceBranch === input.targetBranch) {
      throw new WorkflowValidationError('source and target branches must differ');
    }
    if (!input.title?.trim()) throw new WorkflowValidationError('title is required');
    if (isProtectedBranch(input.sourceBranch)) {
      throw new WorkflowValidationError(
        `Cannot open a change request *from* a protected branch ("${input.sourceBranch}").`,
        { kind: 'source-is-protected', sourceBranch: input.sourceBranch },
      );
    }

    // The whole open sequence — uniqueness check through row insert — runs
    // under the source branch's lifecycle lock. `retireMergedSourceBranch`
    // takes the same lock around its own check-then-delete, so a merge
    // cleanup can never race into the multi-second gap between this
    // method's "no open request" answer and its row landing, and delete the
    // branch out from under a request being opened.
    return this.branchLifecycle.run(`branch:${input.sourceBranch}`, async () => {
    // Uniqueness rule — A→B blocks A→B (the spec is explicit that B→A in
    // parallel is still allowed). `listOpenPrs` is cached for 30s so we
    // force-fresh to catch a CR that opened just now.
    const openCrs = await this.prs.listOpenPrs({ fresh: true });
    const duplicate = openCrs.find(
      (cr) => cr.branch === input.sourceBranch && cr.base === input.targetBranch,
    );
    if (duplicate) {
      throw new DuplicateChangeRequestError(
        input.sourceBranch,
        input.targetBranch,
        duplicate.number,
      );
    }

    // Auto-merge target → source. `mergeFromOrigin` enforces "current
    // branch == source" and "clean working tree" before attempting; both
    // failures surface as structured workflow errors that pass straight
    // through to the caller.
    const mergeOutcome = await this.git.mergeFromOrigin(
      workspaceId,
      input.sourceBranch,
      input.targetBranch,
      user,
    );
    if (mergeOutcome.kind === 'conflicts') {
      throw new ChangeRequestConflictsError(
        input.sourceBranch,
        input.targetBranch,
        mergeOutcome.paths,
      );
    }

    // Push the source — `gh pr create` against an unpushed branch returns
    // "head branch does not exist on remote". Push *after* the auto-merge
    // so the remote sees the merge commit too.
    await this.git.push(workspaceId, user);

    const workspacePath = await this.workspaceService.getWorkspacePath(workspaceId);
    const cwd = path.join(workspacePath, this.kbDirName);

    // Touched paths between target and source — basis for the
    // affected-owners block we append to the CR body. We compute it
    // ourselves rather than waiting for GitHub to expose `pr.files`
    // (which only populates after the PR exists). Three-dot range
    // matches what `gh pr create` will eventually show as the diff.
    const touchedPaths = await this.listChangedPathsBetweenBranches(
      cwd,
      input.targetBranch,
      input.sourceBranch,
    );
    const affectedOwnersBlock = await this.buildAffectedOwnersBlock(
      workspaceId,
      input.targetBranch,
      touchedPaths,
    );

    // The change request is a plain DB row now — no provider PR. Author is a
    // real column (no hidden body marker needed, since nothing runs as a shared
    // service account anymore).
    const description = input.description?.trim() ?? '';
    const body = [description, affectedOwnersBlock].filter((s) => s.length > 0).join('\n\n');

    let prNumber: number;
    try {
      const [row] = await this.db
        .insert(changeRequests)
        .values({
          sourceBranch: input.sourceBranch,
          targetBranch: input.targetBranch,
          title: input.title.trim(),
          body,
          authorEmail: user.email.trim().toLowerCase(),
          authorName: user.name,
        })
        .returning({ number: changeRequests.number });
      prNumber = row.number;
    } catch (err) {
      // The partial unique index (source, target WHERE state='open') is the
      // race-proof backstop for the pre-check above: a concurrent open of the
      // same pair lands here. Surface it as the same duplicate error, with the
      // winning CR's number. Any OTHER unique violation (e.g. the identity
      // `change_requests_number_unq`) is a genuine integrity fault and falls
      // through to the generic path below rather than being mislabeled.
      if (isOpenPairViolation(err)) {
        const [existing] = await this.db
          .select({ number: changeRequests.number })
          .from(changeRequests)
          .where(
            and(
              eq(changeRequests.sourceBranch, input.sourceBranch),
              eq(changeRequests.targetBranch, input.targetBranch),
              eq(changeRequests.state, 'open'),
            ),
          )
          .limit(1);
        // Normally the conflicting open CR is right there. If it vanished (the
        // rival was merged/closed in the microsecond between the conflict and
        // this re-query), don't fabricate a #0 — report it as a transient race.
        if (!existing) {
          throw new WorkflowValidationError(
            `Change request for "${input.sourceBranch}" → "${input.targetBranch}" ` +
              'raced with a concurrent open/close; retry.',
            { kind: 'open-change-request-failed' },
          );
        }
        throw new DuplicateChangeRequestError(
          input.sourceBranch,
          input.targetBranch,
          existing.number,
        );
      }
      // Non-uniqueness failure AFTER the auto-merge + push already advanced the
      // source branch: no `change_requests` row was created, but the source now
      // carries the auto-merge commit. This is safely retryable — re-running
      // openChangeRequest finds no duplicate, re-runs the (idempotent, already
      // up-to-date) auto-merge, and inserts the row.
      const rawMsg = err instanceof Error ? err.message : String(err);
      throw new WorkflowValidationError(
        `Failed to open change request: ${redactTokens(rawMsg)}`,
        { kind: 'open-change-request-failed' },
      );
    }
    this.prs.invalidateDetailCache(prNumber);

    const detail = await this.prs.getPrDetail(prNumber, {
      fresh: true,
      workspaceId,
      viewerEmail: user.email,
    });
    if (!detail) {
      throw new WorkflowValidationError(
        `Created change request #${prNumber} but could not fetch its detail`,
      );
    }
    this.events?.emit({
      kind: 'change-request-opened',
      number: prNumber,
      source: input.sourceBranch,
      target: input.targetBranch,
      authorIdHash: hashEmail(user.email),
      title: input.title,
    });
    return detail;
    });
  }

  /**
   * Refresh an existing change request from its target — re-runs the
   * `target → source` auto-merge so the CR diff reflects what the merge
   * would actually produce against the current target. Conflicts surface
   * as `ChangeRequestConflictsError`; the caller (UI or agent) is expected
   * to route into the resolution flow exactly as on open.
   *
   * Approvals on files touched by the merge resolution invalidate
   * automatically — they're pinned to the head SHA, and any new commit on
   * source drops the per-file approval gate (handled by the existing
   * approval staleness check). No special bookkeeping needed here.
   */
  async updateFromTarget(
    workspaceId: string,
    user: AuthUser,
    number: number,
  ): Promise<ChangeRequestDetail> {
    const detail = await this.prs.getPrDetail(number, { fresh: true, workspaceId, viewerEmail: user.email });
    if (!detail) {
      throw new WorkflowValidationError(
        `Change request #${number} not found.`,
        { kind: 'change-request-not-found', number },
      );
    }
    if (detail.state !== 'open') {
      throw new WorkflowValidationError(
        `Change request #${number} is ${detail.state} — only open requests can refresh from target.`,
        { kind: 'change-request-not-open', state: detail.state },
      );
    }
    const outcome = await this.git.mergeFromOrigin(
      workspaceId,
      detail.branch,
      detail.base,
      user,
    );
    if (outcome.kind === 'conflicts') {
      throw new ChangeRequestConflictsError(detail.branch, detail.base, outcome.paths);
    }
    // If a new merge commit landed, push so the CR picks it up. When
    // already up to date there's nothing to share — short-circuit the push.
    if (!outcome.alreadyUpToDate) {
      await this.git.push(workspaceId, user);
    }
    this.prs.invalidateDetailCache(number);
    const refreshed = await this.prs.getPrDetail(number, {
      fresh: true,
      workspaceId,
      viewerEmail: user.email,
    });
    if (!refreshed) {
      throw new WorkflowValidationError(
        `Refreshed change request #${number} but could not re-fetch its detail.`,
      );
    }
    return refreshed;
  }

  listComments(number: number): Promise<ChangeRequestComment[]> {
    return this.reviewWorkflow.listComments(number);
  }

  async postComment(
    number: number,
    user: AuthUser,
    input: PostChangeRequestCommentInput,
    headSha: string,
  ): Promise<ChangeRequestComment> {
    const comment = await this.reviewWorkflow.postComment(number, user, input, headSha);
    this.prs.invalidateDetailCache(number);
    return comment;
  }

  async editComment(
    commentId: string,
    number: number,
    user: AuthUser,
    body: string,
  ): Promise<ChangeRequestComment> {
    const updated = await this.reviewWorkflow.editComment(commentId, number, user, body);
    this.prs.invalidateDetailCache(number);
    return updated;
  }

  async deleteComment(commentId: string, number: number, user: AuthUser): Promise<void> {
    await this.reviewWorkflow.deleteComment(commentId, number, user);
    this.prs.invalidateDetailCache(number);
  }

  async approveFile(
    number: number,
    path: string,
    user: AuthUser,
    files: ChangedFile[],
    headSha: string,
    baseBranch: string,
    authorIdHash: string | null,
    workspaceId: string,
  ): Promise<FileApproval[]> {
    const approvals = await this.reviewWorkflow.approveFile(
      number,
      path,
      user,
      files,
      headSha,
      baseBranch,
      authorIdHash,
      workspaceId,
    );
    this.prs.invalidateDetailCache(number);
    this.events?.emit({
      kind: 'approval-changed',
      number,
      path,
      approverUserId: user.id,
      change: 'added',
    });
    return approvals;
  }

  async unapproveFile(
    number: number,
    path: string,
    user: AuthUser,
    files: ChangedFile[],
    headSha: string,
    baseBranch: string,
    authorIdHash: string | null,
    workspaceId: string,
  ): Promise<FileApproval[]> {
    const approvals = await this.reviewWorkflow.unapproveFile(
      number,
      path,
      user,
      files,
      headSha,
      baseBranch,
      authorIdHash,
      workspaceId,
    );
    this.prs.invalidateDetailCache(number);
    this.events?.emit({
      kind: 'approval-changed',
      number,
      path,
      approverUserId: user.id,
      change: 'removed',
    });
    return approvals;
  }

  /**
   * Reject (close-without-merging) a change request. Per PLAN.md spec, the
   * authorized set is:
   *   - the CR author (hash-matched against the body marker), OR
   *   - any user with write permission to *every* changed file on the
   *     target branch, OR
   *   - an admin (write on `roles.yaml` at `origin/<target>`).
   *
   * The first and third are enforced by the underlying `cancelPr`. The
   * second is the workflow's broader rule; we check it here and, on
   * success, spoof `authorIdHash` to `hashEmail(user.email)` so `cancelPr`
   * accepts the call via its existing "viewer is author" branch. The
   * spoofing is safe because no caller outside this method can construct
   * an `authorIdHash` that matches its own email's hash — `cancelPr`
   * receives the hash via this internal call only.
   */
  async rejectChangeRequest(
    number: number,
    user: AuthUser,
    state: ChangeRequestState,
    authorIdHash: string | null,
    baseBranch: string,
    workspaceId: string,
  ): Promise<CancelChangeRequestResult> {
    let effectiveAuthorIdHash = authorIdHash;
    const callerHash = hashEmail(user.email);
    const callerIsAuthor = !!(authorIdHash && authorIdHash === callerHash);

    if (!callerIsAuthor) {
      // Broader rule: write perm on every changed file at origin/<target>.
      // The path list comes from the PR detail — fetch fresh so the rule
      // applies against the current head (a stale list would let a user
      // reject a CR whose files they no longer all own).
      const detail = await this.prs.getPrDetail(number, {
        fresh: true,
        workspaceId,
        viewerEmail: user.email,
      });
      const paths = detail?.files.map((f) => f.path) ?? [];
      if (paths.length > 0) {
        const writeMap = await this.accessControl.canWriteBatchAtRef(
          workspaceId,
          `origin/${baseBranch}`,
          user.email,
          paths,
        );
        const writesAll = !!writeMap && paths.every((p) => writeMap.get(p) === true);
        if (writesAll) {
          // Spoof so the underlying `cancelPr` authorizes via its viewer-
          // is-author branch. The admin branch (write on roles.yaml) still
          // works alongside — `cancelPr` checks both.
          effectiveAuthorIdHash = callerHash;
        }
      }
    }

    const result = await this.reviewWorkflow.cancelPr(
      number,
      user,
      state,
      effectiveAuthorIdHash,
      baseBranch,
      workspaceId,
    );
    this.prs.invalidateDetailCache(number);
    this.events?.emit({ kind: 'change-request-rejected', number });
    return result;
  }

  /**
   * Merge a change request. The underlying `mergePr` does a local
   * `git merge --no-ff` + push; when it hits conflicts it throws
   * `ChangeRequestConflictsError`, which we translate into a structured
   * `conflicts-need-resolution` outcome (carrying the actual conflicting
   * paths) so the agent can resolve them on the source branch and retry.
   *
   * Hard-block and warning gates (PR state, approvals, admin bypass) are
   * still enforced by the underlying `mergePr` — this method just adds
   * the conflict short-circuit on top.
   */
  async mergeChangeRequest(
    number: number,
    user: AuthUser,
    headSha: string,
    approvals: FileApproval[],
    state: ChangeRequestState,
    title: string,
    baseBranch: string,
    workspaceId: string,
    opts?: { bypass?: boolean },
  ): Promise<MergeChangeRequestOutcome> {
    // Conflicts are surfaced by the local merge itself now (with the actual
    // conflicting paths) — no provider "mergeable" pre-check needed.

    // roles.yaml is the file that decides admin membership, and only an admin
    // may edit it (enforced at lock-acquire on protected branches). Feature
    // branches are a free-for-all, so a non-admin CAN edit roles.yaml on their
    // own draft — and a CR merge is the one path that lands draft content on a
    // protected branch. To stop that becoming a privilege-escalation vector, we
    // never let a CR carry a roles.yaml change across the merge: if the CR's
    // roles.yaml differs from the base branch's, we restore the base version on
    // the source branch (commit + push) BEFORE merging, so the merged diff
    // carries no roles.yaml change. roles.yaml is mutable ONLY via the admin
    // Roles & Members surface (itself admin-gated). The rest of the CR merges
    // normally. Best-effort by design is NOT acceptable here — a failure to
    // neutralise must abort the merge, never fall through.
    const preserved = await this.preserveBaseRolesYaml(number, user, baseBranch);

    // When preservation pushed a restore commit, the source-branch head advanced,
    // so the caller's `headSha`/`approvals` (resolved against the pre-preservation
    // head) are now stale — wrong for the merge log's `headShaAtMerge` and for the
    // approval-staleness the gate reads. Re-resolve from the live PR before merging.
    // Fail CLOSED: if the fresh detail can't be loaded we abort rather than fall
    // back to the stale inputs — merging on outdated gate inputs after a
    // security-sensitive rewrite is exactly what this path exists to prevent.
    let mergeHeadSha = headSha;
    let mergeApprovals = approvals;
    if (preserved) {
      const fresh = await this.getChangeRequestDetail(number, {
        fresh: true,
        workspaceId,
        viewerEmail: user.email,
      });
      if (!fresh) {
        throw new RolesYamlPreservationError(
          `could not reload change request #${number} after roles.yaml preservation; refusing to merge on stale gate inputs`,
        );
      }
      mergeHeadSha = fresh.headSha;
      mergeApprovals = fresh.approvals;
    }

    let result;
    try {
      result = await this.reviewWorkflow.mergePr(
        number,
        user,
        mergeHeadSha,
        mergeApprovals,
        state,
        title,
        baseBranch,
        workspaceId,
        opts,
      );
    } catch (err) {
      // The local merge hit conflicts — hand the caller (agent/UI) the actual
      // conflicting paths so they can resolve on the source branch and retry.
      if (err instanceof ChangeRequestConflictsError) {
        return { kind: 'conflicts-need-resolution', conflictedPaths: err.conflictedPaths };
      }
      throw err;
    }
    // The merge landed on `origin/<baseBranch>`. Pull the
    // TARGET branch's own workspace so its working tree doesn't fall behind the
    // remote — the file tools serve the working tree (not origin), so without
    // this a read right after a merge misses the just-merged change. Best-effort:
    // the merge already succeeded on origin, so a pull hiccup must not fail the
    // response (a later fetch/pull reconciles).
    let targetWorkspaceId: string | undefined;
    try {
      const targetWorkspace = await this.workspaceService.getOrCreateForBranch(baseBranch);
      targetWorkspaceId = targetWorkspace.id;
      await this.git.pull(targetWorkspace.id);
    } catch (err) {
      // Still best-effort for the merge response (the merge already landed
      // on origin) — but a rebase CONFLICT here means the target workspace
      // is stranded (local commits vs origin, never self-heals), so queue
      // the background recovery ladder before shrugging. A conflict can
      // only have come from the pull, so the workspace id is always set on
      // this arm — the guard just satisfies the narrowing.
      if (err instanceof PullRebaseConflictError && targetWorkspaceId) {
        await this.queuePullConflictRecovery(targetWorkspaceId, err, user);
      }
      console.warn(
        `[merge] post-merge pull of target "${baseBranch}" failed — its workspace may be momentarily behind origin`,
        err,
      );
    }
    this.prs.invalidateDetailCache(number);
    this.events?.emit({ kind: 'change-request-merged', number });
    // AFTER the event: the applying UI is waiting on `change-request-merged`,
    // and branch retirement is git IO it must never wait behind.
    await this.retireMergedSourceBranch(number, baseBranch, user);
    return { kind: 'merged', result };
  }

  /**
   * Best-effort retirement of a merged change request's source branch — the
   * standard "delete branch on merge" a git host performs, done here because
   * this app IS the host. Everything the branch carried is on the target
   * now, and leaving it behind has a real cost: the propose flow REUSES an
   * existing branch by name, so a leftover base goes stale against the
   * target and seeds the next proposal with outdated text (or, worse,
   * re-proposes withdrawn commits).
   *
   * Refuses quietly when the branch is protected or still carries another
   * OPEN request. Runs from the TARGET's workspace (guaranteed not to be
   * checked out on the branch being deleted) with `systemCleanup`, since the
   * merger need not be the branch's author — the merge itself was the
   * authorization. Never throws: the merge has already succeeded, and a
   * cleanup failure only means the next proposal falls back to branch reuse.
   */
  private async retireMergedSourceBranch(
    number: number,
    baseBranch: string,
    user: AuthUser,
  ): Promise<void> {
    try {
      const rows = await this.db
        .select({ sourceBranch: changeRequests.sourceBranch })
        .from(changeRequests)
        .where(eq(changeRequests.number, number))
        .limit(1);
      const sourceBranch = rows[0]?.sourceBranch;
      if (!sourceBranch || isProtectedBranch(sourceBranch)) return;
      // The open-check and the deletion hold the branch's lifecycle lock
      // TOGETHER — `openChangeRequest` holds the same lock across its own
      // check-then-insert, so a request being opened from this branch either
      // lands its row before the check below (retirement backs off) or waits
      // until retirement finishes (and fails loudly on the missing branch,
      // retryable, instead of losing the branch mid-open).
      await this.branchLifecycle.run(`branch:${sourceBranch}`, async () => {
        const stillOpen = await this.db
          .select({ number: changeRequests.number })
          .from(changeRequests)
          .where(
            and(
              eq(changeRequests.sourceBranch, sourceBranch),
              eq(changeRequests.state, 'open'),
            ),
          )
          .limit(1);
        if (stillOpen.length > 0) return;

        const targetWs = await this.workspaceService.getOrCreateForBranch(baseBranch);
        // The remote-tracking ref must be current, or deleteBranch's
        // "does origin still have it?" probe skips the remote delete.
        await this.workspaceService.ensureRemotesFetched(targetWs.id).catch(() => {});
        await this.deleteBranchUnlocked(targetWs.id, sourceBranch, user, { systemCleanup: true });
        console.log(`[merge] retired merged source branch "${sourceBranch}"`);
      });
    } catch (err) {
      console.warn(
        `[merge] could not retire the merged source branch of change request #${number} (non-fatal):`,
        err,
      );
    }
  }

  /**
   * Guarantee a CR carries NO `roles.yaml` change across its merge: if the CR's
   * `roles.yaml` differs from the base branch's, restore the base version on the
   * SOURCE branch (commit + push) so the merged diff has no roles.yaml change.
   * No-op when the CR doesn't touch roles.yaml. Always resolves identity from
   * `origin/<base>` and `origin/<head>` (the published state) — never the local
   * working tree, which a caller could have dirtied.
   *
   * Fail-CLOSED: any error restoring the base version throws
   * {@link RolesYamlPreservationError}, aborting the merge. We must never let a
   * roles.yaml change slip through because the neutralisation step failed.
   */
  private async preserveBaseRolesYaml(
    number: number,
    user: AuthUser,
    baseBranch: string,
  ): Promise<boolean> {
    const ROLES_YAML = 'roles.yaml';
    let headBranch: string;
    try {
      const summary = await this.prs.getPr(number);
      if (!summary) throw new Error(`change request #${number} not found`);
      // Use the PR's own authoritative base rather than trusting the caller's
      // baseBranch arg throughout — cross-check to catch stale/mismatched inputs.
      if (summary.base !== baseBranch)
        throw new Error(
          `change request #${number} base mismatch: expected "${baseBranch}", PR reports "${summary.base}"`,
        );
      headBranch = summary.branch;
      // A CR into a protected branch is the only escalation vector we're closing;
      // base is always a protected branch here, head is always a feature branch.
      // Guard against a degenerate self-targeting CR (head === base) just in case.
      if (!headBranch || headBranch === summary.base) return false;

      // Work in the SOURCE branch's own per-branch workspace (already checked out
      // on that branch). Fetch so we read the CR's TRUE published roles.yaml from
      // the origin refs below (the comparison never touches the working tree) and
      // so a restoring commit fast-forwards on push. We deliberately DON'T
      // `resetToRemote` here: that workspace is shared per-branch and can carry
      // disk-first edits whose commits are still queued (see PendingCommitsService),
      // and a hard reset would silently discard them.
      const ws = await this.workspaceService.getOrCreateForBranch(headBranch);
      await this.git.fetch(ws.id);

      const baseRoles = await this.git.readFileAtRef(ws.id, `origin/${summary.base}`, ROLES_YAML);
      const headRoles = await this.git.readFileAtRef(ws.id, `origin/${headBranch}`, ROLES_YAML);

      // Identical (incl. both-absent) → the CR doesn't change roles.yaml. Done.
      if (baseRoles === headRoles) return false;

      // The restore below writes roles.yaml directly to the shared per-branch
      // working tree. `LockingFilesystem` serializes every OTHER roles.yaml edit
      // (human save button, agent write) through the SAME per-file lock, keyed on
      // the workspace-relative path (`<kbDirName>/roles.yaml`) — see
      // `access.routes.ts` (`wsEditPath`) and `LockingFilesystem.withLock`. Take
      // that lock here too, or a concurrent same-branch editor can overwrite our
      // restore between the write and the commit (or slip a fresh roles.yaml
      // change past the neutralisation). Contended → the editor holds it → fail
      // CLOSED: abort the merge rather than race. TTL-expiry on abandoned locks
      // means a stale holder can't wedge merges forever.
      const rolesLockPath = `${this.kbDirName}/${ROLES_YAML}`;
      const lock = await this.fileLocks.acquire(ws.id, headBranch, rolesLockPath, user);
      if (!lock.acquired) {
        throw new Error(
          `roles.yaml is being edited on "${headBranch}" (locked by ${lock.lock.holderName}); refusing to merge until the edit settles`,
        );
      }

      try {
        // Restore the base version on the source branch so the change disappears
        // from the merge diff. (If base has no roles.yaml at all — baseRoles ===
        // null — restore by deleting the file.)
        const repoDir = path.join(await this.workspaceService.getWorkspacePath(ws.id), this.kbDirName);
        const abs = path.join(repoDir, ROLES_YAML);
        if (baseRoles === null) {
          await fs.rm(abs, { force: true });
        } else {
          await fs.writeFile(abs, baseRoles, 'utf-8');
        }

        // Commit ONLY roles.yaml via commitFile (`git add -- roles.yaml`), never
        // `commitChanges` (`git add -A`): on this shared per-branch workspace other
        // files may be dirty from a concurrent same-branch save, and `add -A` would
        // sweep those unrelated edits into our "preserve roles.yaml" commit under the
        // wrong author/message. Feature branch → the protected-branch gate doesn't
        // fire, so this commits cleanly. Then publish so the merge sees the
        // neutralised source. A non-fast-forward push (the source advanced under us)
        // throws → RolesYamlPreservationError → the merge aborts, fail-closed.
        const committed = await this.git.commitFile(
          ws.id,
          user,
          ROLES_YAML,
          'Preserve official roles.yaml (not editable via change request)',
          true, // skipValidator — this restores an already-validated base version
        );

        // We are past the `baseRoles === headRoles` check, so origin/<head> and
        // origin/<base> DO differ — a restore commit is REQUIRED to protect the
        // remote. If commitFile produced nothing (the local working tree already
        // matched the base version, e.g. the per-branch checkout is out of sync
        // with origin/<head>), then origin/<head> STILL carries the divergent
        // roles.yaml and the merge would land it. Treat that as a hard failure —
        // returning false here would fail OPEN. Fail closed instead.
        if (!committed) {
          throw new Error(
            'roles.yaml restore produced no commit while origin still diverges from base — source workspace out of sync; refusing to merge',
          );
        }
        await this.git.push(ws.id, user);
        this.accessControl.invalidate(ws.id);
        return true;
      } finally {
        // We already committed inline, so drop the lock row directly rather than
        // going through `releaseLock` (which would enqueue a duplicate commit).
        await this.fileLocks.release(ws.id, headBranch, rolesLockPath, user);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Log the raw git/push detail server-side; the thrown error keeps it OFF
      // the client-facing 502 message (see RolesYamlPreservationError).
      console.warn(`[merge] roles.yaml preservation failed for #${number}:`, detail);
      throw new RolesYamlPreservationError(detail);
    }
  }

  /**
   * Names of files changed between the target branch (on origin) and the
   * source (HEAD) — the diff the CR will surface. Three-dot range so
   * commits that exist only on origin/target but not on source don't
   * inflate the list. Failures fall back to an empty list — a missing
   * affected-owners block is cosmetic, not a reason to abort CR creation.
   */
  private async listChangedPathsBetweenBranches(
    cwd: string,
    targetBranch: string,
    sourceBranch: string,
  ): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', cwd, 'diff', '--name-only', `origin/${targetBranch}...${sourceBranch}`],
        { env: { ...process.env }, maxBuffer: 4 * 1024 * 1024 },
      );
      return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch (err) {
      console.warn(
        '[workflow] listChangedPathsBetweenBranches failed:',
        redactTokens(err instanceof Error ? err.message : String(err)),
      );
      return [];
    }
  }

  /**
   * Build the `## Affected owners` markdown block that gets appended to
   * the CR body. Lists the eligible approvers (roles + named users) per
   * changed path, per the access tree on `origin/<targetBranch>` — the same
   * tree the approval gate uses server-side, so what the body advertises
   * matches who can actually approve at merge time. The per-path list is
   * capped (see {@link formatAffectedOwnersBlock}) so the body stays within
   * the `gh pr create --body` arg limit on large changesets.
   *
   * Returns the empty string when there are no touched paths or no
   * resolvable eligibility — keeps the body clean rather than printing
   * a stub heading.
   */
  private async buildAffectedOwnersBlock(
    workspaceId: string,
    targetBranch: string,
    paths: string[],
  ): Promise<string> {
    if (paths.length === 0) return '';
    let resolved: Awaited<ReturnType<IAccessControl['eligibleWritersForPathsAtRef']>> = null;
    try {
      resolved = await this.accessControl.eligibleWritersForPathsAtRef(
        workspaceId,
        `origin/${targetBranch}`,
        paths,
      );
    } catch (err) {
      console.warn(
        '[workflow] eligibleWritersForPathsAtRef failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!resolved || resolved.size === 0) return '';

    return formatAffectedOwnersBlock(paths, resolved);
  }

}
