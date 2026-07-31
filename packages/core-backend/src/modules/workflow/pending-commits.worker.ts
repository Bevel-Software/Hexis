/**
 * Background worker that drains the `pending_commits` queue: claims a row,
 * runs `commitFile + pushWithRecovery` against the workspace, and either
 * deletes the row (success) or schedules a retry (transient failure) or a
 * recovery-agent run (exhausted transient budget). After the
 * recovery-agent ceiling we escalate to a `'system'` feedback notice.
 *
 * Design context: `lock-decoupling-plan.md`.
 *
 * One worker per backend process; we don't currently run multi-replica
 * backends, so a single drain loop is fine. The `claimNext` SQL uses
 * `FOR UPDATE SKIP LOCKED` so a future multi-replica deployment can run
 * multiple workers without double-processing rows.
 *
 * Concurrency: at most one commit in flight at a time across all
 * workspaces. We could parallelise across workspaces (different
 * `mutex.run` keys), but the current commit volume is comfortably
 * sequential and the simpler shape catches more potential bugs.
 */

import type { AuthUser } from '@bevel-software/platform-shared';
import type {
  PendingCommit,
  PendingCommitsService,
  WorkspaceDescriptor,
} from './pending-commits.service.js';
import { BACKOFF_MS, N_RECOVERY, N_TRANSIENT } from './pending-commits.service.js';
import { sanitizeError } from './sanitize-error.js';

/**
 * Where the worker escalates terminal failures — the narrow, workflow-owned
 * slice of whatever notice sink the app provides. The enterprise app passes
 * its feedback service (structurally compatible: its `send` accepts a wider
 * source union); a core-only deployment can pass
 * {@link consoleSystemNoticeSink}, which just logs.
 */
export interface ISystemNoticeSink {
  send(notice: {
    source: 'system';
    user: { id: string; email: string; name: string };
    message: string;
  }): Promise<void>;
}

/** Core default: terminal-failure notices go to stderr (no dashboard). */
export const consoleSystemNoticeSink: ISystemNoticeSink = {
  async send(notice) {
    console.error(`[system-notice] ${notice.user.email}: ${notice.message}`);
  },
};

/**
 * Idle poll interval between drain sweeps. Half a second is short enough
 * that the post-save commit lag is invisible to humans, long enough that
 * an empty queue doesn't burn DB round-trips.
 */
const POLL_INTERVAL_MS = 500;

/**
 * The recovery-agent dispatcher the worker calls when a row exhausts its
 * transient budget. Pulled behind an interface so the unit tests can
 * substitute a fake without bringing the entire BackgroundAgentFactory
 * along.
 */
export interface RecoveryAgentRunner {
  /**
   * Kick off one recovery-agent run for a stuck pending commit. The
   * agent's commits enqueue normal `pending_commits` rows that the
   * worker drains on subsequent passes — that's how the recovery
   * commits AND the original orphan both land.
   *
   * Implementations should await the agent's terminal step before
   * returning so the worker's retry budget counts whole runs, not
   * mid-stream tool calls.
   */
  run(input: {
    workspaceId: string;
    branch: string;
    path: string;
    lastError: string;
    originalAuthorEmail: string;
  }): Promise<void>;
}

/**
 * Workflow surface the worker depends on. A subset of the real
 * `WorkflowService` — pulled behind an interface so tests can stub the
 * commit/push pipeline without spinning up a real git workspace.
 */
export interface WorkflowCommitDriver {
  /**
   * Commit whatever's currently on disk for `path`, then push the branch.
   * Uses `pushWithRecovery` semantics internally (cooperative pull-rebase
   * on non-FF). Throws when commit / push terminally fail; the worker
   * catches and decides whether to retry or escalate.
   */
  runPendingCommit(
    workspaceId: string,
    branch: string,
    path: string,
    user: AuthUser,
  ): Promise<void>;
}

/**
 * Source of workspaces to poll. The real implementation reads
 * `WorkspaceService.branchDirs.keys()` — the in-memory cache of
 * already-bootstrapped branches. Lazy-bootstrapped workspaces show up
 * here as soon as `getOrCreateForBranch` resolves, so a freshly-touched
 * branch's commits start draining within one poll interval.
 */
export interface WorkspaceProvider {
  knownWorkspaces(): Iterable<WorkspaceDescriptor>;
}

export interface PendingCommitsWorkerDeps {
  service: PendingCommitsService;
  workflow: WorkflowCommitDriver;
  recoveryAgent: RecoveryAgentRunner;
  feedback: ISystemNoticeSink;
  workspaces: WorkspaceProvider;
  /**
   * The synthetic identity used for `'system'` feedback notices when a
   * row terminally fails. Author of the recovery commits themselves is
   * the recovery agent's own configured user — that's a separate concern.
   */
  recoveryBot: { id: string; email: string; name: string };
  /** Test seam — defaults to `Date.now`. */
  now?: () => Date;
  /** Test seam — defaults to `setTimeout` wrapped as a promise. */
  sleep?: (ms: number) => Promise<void>;
}

export class PendingCommitsWorker {
  private readonly deps: Required<Omit<PendingCommitsWorkerDeps, 'recoveryBot'>> & {
    recoveryBot: PendingCommitsWorkerDeps['recoveryBot'];
  };
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private stopSignal: ((value: void) => void) | null = null;

  constructor(deps: PendingCommitsWorkerDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? (() => new Date()),
      sleep: deps.sleep ?? defaultSleep,
    };
  }

  /**
   * Start the drain loop. Idempotent — a second `start()` while the
   * worker is already running is a no-op.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  /**
   * Stop the drain loop. Awaits the in-flight pass (so a commit
   * mid-flight gets to finish or fail naturally), then resolves.
   * Idempotent.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    // Unblock the sleep early so shutdown isn't gated on POLL_INTERVAL_MS.
    if (this.stopSignal) {
      const signal = this.stopSignal;
      this.stopSignal = null;
      signal();
    }
    await this.loopPromise;
    this.loopPromise = null;
  }

  /**
   * Run one drain pass: rotate through known workspaces, claim+process
   * one row from each. Exposed publicly so tests can step the loop
   * deterministically without driving `setTimeout`.
   */
  async drainOnce(): Promise<void> {
    for (const workspace of this.deps.workspaces.knownWorkspaces()) {
      // Bail mid-sweep if stop() fired — the in-flight workspace gets
      // to finish but we don't start a new one.
      if (!this.running) return;
      const row = await this.deps.service.claimNext(workspace.id, this.deps.now());
      if (!row) continue;
      await this.processRow(row);
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.drainOnce();
      } catch (err) {
        // A throw out of drainOnce means something inside the loop
        // itself failed — claimNext, processRow's outer scope, etc.
        // Log loudly and keep looping; the next pass may succeed.
        console.error(
          '[pending-commits] worker loop iteration threw:',
          err instanceof Error ? err.stack ?? err.message : err,
        );
      }
      if (!this.running) break;
      await this.interruptibleSleep(POLL_INTERVAL_MS);
    }
  }

  private async interruptibleSleep(ms: number): Promise<void> {
    if (!this.running) return;
    await Promise.race([
      this.deps.sleep(ms),
      new Promise<void>((resolve) => {
        this.stopSignal = resolve;
      }),
    ]);
  }

  /**
   * Process a single claimed row. Outcome paths (see plan §lifecycle):
   *   - commit + push succeeds → delete the row.
   *   - throws, transient budget remains → markTransientFailure.
   *   - throws, transient exhausted, recovery budget remains → spawn agent.
   *   - throws, recovery exhausted → markNeedsAttention + feedback notice.
   */
  private async processRow(row: PendingCommit): Promise<void> {
    const user: AuthUser = {
      // The worker doesn't have a real `users.id` for the commit author —
      // commit attribution flows through `git commit --author="Name <email>"`,
      // not through any FK. Drop a synthetic id so the AuthUser shape is
      // satisfied without hitting the users table.
      id: `pending-commit-author:${row.authorEmail}`,
      email: row.authorEmail,
      name: row.authorName,
    };
    try {
      await this.deps.workflow.runPendingCommit(row.workspaceId, row.branch, row.path, user);
      await this.deps.service.markSucceeded(row.id);
      return;
    } catch (err) {
      // Sanitize once at the source: this string flows into the DB
      // (`pending_commits.last_error`), stdout logs, the recovery-agent
      // LLM prompt, AND the user-facing feedback notice. Git stderr can
      // contain credentialed URLs ("https://x-access-token:ghp_…@…"); we
      // can't undo a persisted leak, so mask before any of them sees it.
      const message = sanitizeError(err);
      const nextAttempts = row.attempts + 1;

      if (nextAttempts < N_TRANSIENT) {
        // Transient — back off and retry on the next sweep that finds
        // the backoff elapsed.
        await this.deps.service.markTransientFailure(row.id, message);
        console.warn(
          `[pending-commits] transient failure ws=${row.workspaceId} branch=${row.branch} path=${row.path} attempt=${nextAttempts}/${N_TRANSIENT}: ${message}`,
        );
        return;
      }

      if (row.recoveryAgentRuns < N_RECOVERY) {
        // Transient budget exhausted — hand off to the recovery agent.
        // markRecoveryStarted resets `attempts` so the post-recovery
        // commits get a fresh transient budget.
        await this.deps.service.markRecoveryStarted(row.id);
        console.warn(
          `[pending-commits] transient budget exhausted ws=${row.workspaceId} branch=${row.branch} path=${row.path}; spawning recovery agent (run ${row.recoveryAgentRuns + 1}/${N_RECOVERY}): ${message}`,
        );
        try {
          await this.deps.recoveryAgent.run({
            workspaceId: row.workspaceId,
            branch: row.branch,
            path: row.path,
            lastError: message,
            originalAuthorEmail: row.authorEmail,
          });
        } catch (agentErr) {
          // The recovery agent itself crashed (rare — would mean broken
          // codemode wiring, missing deps, etc.). Treat it the same as
          // the agent finishing without resolving the issue — the row
          // stays `pending` and the next worker pass will hit the same
          // underlying error or escalate after another recovery cycle.
          console.error(
            `[pending-commits] recovery agent threw for ws=${row.workspaceId} path=${row.path}:`,
            sanitizeError(agentErr),
          );
        }
        return;
      }

      // Recovery budget exhausted — escalate.
      await this.deps.service.markNeedsAttention(row.id, message);
      console.error(
        `[pending-commits] TERMINAL ws=${row.workspaceId} branch=${row.branch} path=${row.path} after ${N_RECOVERY} recovery runs: ${message}`,
      );
      try {
        await this.deps.feedback.send({
          source: 'system',
          user: this.deps.recoveryBot,
          message: terminalFailureNotice(row, message),
        });
      } catch (feedbackErr) {
        // Don't let a feedback-sink hiccup mask the underlying terminal
        // failure — the row is already `needs_attention` and the next
        // process restart will keep logging it. Just note that the
        // notice didn't reach the dashboard.
        console.error(
          `[pending-commits] failed to emit terminal-failure feedback notice for ws=${row.workspaceId} path=${row.path}:`,
          sanitizeError(feedbackErr),
        );
      }
    }
  }
}

function terminalFailureNotice(row: PendingCommit, error: string): string {
  const elapsedMs = Date.now() - row.queuedAt.getTime();
  const elapsed = formatElapsed(elapsedMs);
  return [
    `[pending_commits] Terminal commit failure after ${N_RECOVERY} recovery attempts.`,
    '',
    `Workspace: ${row.workspaceId}`,
    `Branch:    ${row.branch}`,
    `Path:      ${row.path}`,
    `Original author: ${row.authorEmail}`,
    `Queued at: ${row.queuedAt.toISOString()} (${elapsed} ago)`,
    `Last error: ${error}`,
    '',
    "This file's bytes are on disk in the workspace but have never been",
    'committed to git. The recovery agent attempted to fix the underlying',
    `issue ${N_RECOVERY} times without success.`,
    '',
    'Investigate manually:',
    '  - shell into the deployment, cd into the workspace dir',
    "  - inspect `git status` and the file's on-disk state",
    '  - either commit the file manually (after fixing the underlying issue)',
    '    or delete the row from pending_commits if the file should be',
    '    discarded.',
  ].join('\n');
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-exports so consumers can pull worker + constants from one place
// without reaching into the service file for the budgets.
export { BACKOFF_MS, N_RECOVERY, N_TRANSIENT };
