import type { Server } from 'node:http';
import { closeDb, type Database } from '../modules/database/connection.js';
import type { AdvisoryLease } from '../modules/database/advisory-lock.js';
import { bootMaySurvive, type KbStartupRunner } from '../modules/workspace/startup/kb-startup-runner.js';
import { noteBesideCheckout } from '../modules/workspace/startup/beside-checkout.js';
import { unregisterBevelSecretsVariableLoader } from '../modules/secrets-vault/secrets-variable-loader.js';
import type { WorkflowService } from '../modules/workflow/workflow.service.js';
import type { PluginJoinRequestJobs } from '../modules/plugins/join-request-jobs.service.js';
import { printable } from '../shared/printable.js';
import { logger } from '../shared/logging.js';

const startupLog = logger('kb-startup');
const crLog = logger('cr');

/**
 * The process lifecycle: who may drain the commit queue, and how the process
 * stops.
 *
 * Hexis is single-replica by design, and nothing used to enforce it — while
 * the deployment topology guarantees two processes on every redeploy, for as
 * long as the outgoing container takes to exit. Two commit workers sharing
 * one `workspaces` volume run two in-process mutexes, which is no mutual
 * exclusion at all: `SKIP LOCKED` keeps them off the same ROW, and nothing
 * keeps them out of the same working tree. The lease loop below is what
 * does: the worker drains only while this process holds the commit-worker
 * lease, and a process that does not hold it serves HTTP and declines to
 * drain, retrying until the holder exits.
 *
 * And a process that could not stop cleanly dropped everything it held on
 * the way out: an in-flight push killed mid-write, SSE streams cut without a
 * word, the pool's connections left for the server to time out. The shutdown
 * sequence is the order those things are let go in, bounded so a step that
 * hangs cannot outlive the orchestrator's patience.
 */

/** The worker as the lease loop drives it. */
export interface LeasedWorker {
  start(): void;
  stop(): Promise<void>;
}

export interface LeaseLoopOptions {
  /** How often a process that does not hold the lease asks again. Default 5s. */
  retryMs?: number;
  /** Test seam — defaults to `setTimeout` wrapped as a promise. */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface LeaseLoopHandle {
  /** Whether THIS process holds the lease, and so is the one draining. */
  readonly held: boolean;
  /** End the loop: stop the worker if it runs, release the lease. Idempotent. */
  stop(): Promise<void>;
}

const DEFAULT_RETRY_MS = 5_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `worker` for exactly as long as this process holds `lease`.
 *
 * Acquire is a poll rather than a blocking wait, because the process has
 * other work to do meanwhile — every request it serves is served whether or
 * not it is the one draining. On loss the worker is stopped and the loop goes
 * back to asking; on acquisition it starts. A worker mid-`stop` is awaited
 * before any restart, so a loss-then-reacquire within one commit's duration
 * cannot leave two drain loops running in one process.
 *
 * THE ONE WINDOW THIS LEAVES OPEN. A loss is the holding session dying, and
 * from that instant Postgres no longer holds the lock for anyone: the commit
 * in flight here finishes (it cannot be abandoned mid-write without leaving
 * the clone worse), and a replacement that asks in the meantime is granted.
 * Fencing that window would need every git write to carry a token the
 * volume checked, which a filesystem does not do. What bounds it instead:
 * the replacement asks every `retryMs`, a commit takes seconds, and the
 * session dies only when the database or the network does — a fault the
 * whole deployment is already reporting, not a redeploy, where the outgoing
 * holder releases only after its worker has stopped.
 *
 * THE OTHER WINDOW, ON EVERY REDEPLOY. The knowledge-base startup phase — the
 * boot's maintenance of the protected-branch clones, and its retry while the
 * remote is unreachable — runs in the process that is booting, whether or
 * not that process holds the lease (see `createCoreServer`). For the seconds
 * the phase takes, the replacement writes to the shared clones while the
 * outgoing holder may still be committing to them. This is known and left
 * open here: closing it means running the phase only in the holder — before
 * the routes open when the lease is free, as the first leased task when it
 * is not — since waiting for the lease at boot would deadlock the redeploy
 * (the outgoing container stops only once the new one is healthy, and the
 * new one is healthy only after boot). That reshapes the boot and is its own
 * change.
 */
export function holdCommitWorkerLease(
  lease: AdvisoryLease,
  worker: LeasedWorker,
  opts: LeaseLoopOptions = {},
): LeaseLoopHandle {
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((message: string) => logger('lifecycle').info(message));

  let running = true;
  let workerRunning = false;
  let stopping: Promise<void> | null = null;
  let wake: (() => void) | null = null;

  const stopWorker = (): Promise<void> => {
    if (!workerRunning) return stopping ?? Promise.resolve();
    workerRunning = false;
    stopping = worker
      .stop()
      .catch((err: unknown) => log(`commit worker stop failed: ${String(err)}`))
      .finally(() => {
        stopping = null;
      });
    return stopping;
  };

  lease.onLost(() => {
    if (!running) return;
    log('the commit-worker lease was lost — stopping the worker until it is held again');
    void stopWorker();
    wake?.();
  });

  const loop = (async () => {
    while (running) {
      if (stopping) await stopping;
      if (running && !lease.held) {
        let acquired = false;
        try {
          acquired = await lease.tryAcquire();
        } catch (err) {
          log(`could not ask for the commit-worker lease: ${String(err)}`);
        }
        if (acquired && running) {
          workerRunning = true;
          worker.start();
          log('this process holds the commit-worker lease and is draining the queue');
        }
      }
      if (!running) break;
      await Promise.race([
        sleep(retryMs),
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      ]);
      wake = null;
    }
  })();

  let stopped: Promise<void> | null = null;
  return {
    get held() {
      return lease.held;
    },
    stop() {
      stopped ??= (async () => {
        running = false;
        wake?.();
        await loop;
        // The worker is asked to stop whether or not this process is running
        // it: a worker that can be held still (`holdable`) may be in the
        // middle of a hold that uses the database, and its stop is what
        // waits for that. Stopping a worker that is not running is nothing.
        const idle = !workerRunning && !stopping;
        await stopWorker();
        if (idle) await worker.stop().catch((err: unknown) => log(`commit worker stop failed: ${String(err)}`));
        await lease.release();
      })();
      return stopped;
    },
  };
}

/**
 * A worker whose start is preceded by one asynchronous task, run under the
 * same lease: the commit queue's recovery, which resets rows a dead holder
 * left `running` and must therefore run only once this process IS the holder
 * — run at boot, before the lease, it would reset rows the outgoing process
 * is still committing. A task that fails is logged and the worker starts
 * anyway; a stop during the task waits for it, then stops the worker.
 */
export function withStartupTask(
  worker: LeasedWorker,
  task: () => Promise<void>,
  log: (message: string) => void = (message) => logger('lifecycle').warn(message),
): LeasedWorker {
  let starting: Promise<void> | null = null;
  return {
    start() {
      starting ??= task()
        .catch((err: unknown) => log(`startup task failed; the worker starts regardless: ${String(err)}`))
        .then(() => worker.start())
        .finally(() => {
          starting = null;
        });
    },
    async stop() {
      if (starting) await starting;
      await worker.stop();
    },
  };
}

/** A worker the lease loop drives, which something else may hold still for a while. */
export interface HoldableWorker extends LeasedWorker {
  /**
   * Run `work` with the worker stopped, and start it again afterwards if the
   * lease loop still wants it running. A hold waits for the commit in flight
   * to finish, as a stop does. Holds may overlap; the worker starts again
   * when the last one ends, whether `work` resolved or threw.
   */
  whileHeld<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * A worker that can be HELD STILL without the lease loop knowing.
 *
 * The lease loop decides whether this process is the one draining the commit
 * queue; it starts the worker when the lease is taken and stops it when the
 * lease is lost. Moving the deployment to another repository needs a second,
 * independent reason for the worker not to run: while working copies are
 * being set aside and cloned again, a queued commit must not be written into
 * a directory that is being renamed away, nor into the fresh clone of a
 * repository it was never meant for. Stopping the loop itself would release
 * the lease, and another process would take the queue over mid-move.
 *
 * So the two reasons are kept apart. `wanted` is the lease loop's word,
 * `holds` counts the moves in flight, and the worker runs exactly when it is
 * wanted and nothing holds it.
 *
 * A stop waits for the holds in flight as well as for the worker. Shutdown
 * awaits this stop (bounded by its own budget) before it ends the database
 * pool, and a move still setting copies aside and cloning needs that pool:
 * it is either finished, or known to have been cut.
 */
export function holdable(worker: LeasedWorker): HoldableWorker {
  let wanted = false;
  const inFlight = new Set<Promise<unknown>>();
  /**
   * ONE stop at a time, shared by everyone who asks. A worker's own stop is
   * idempotent by answering a second caller at once, while the first is
   * still waiting for the commit in flight; a second hold given that answer
   * would set a working copy aside under that commit.
   */
  let stopping: Promise<void> | null = null;
  const stopWorker = (): Promise<void> => {
    stopping ??= worker.stop().finally(() => {
      stopping = null;
    });
    return stopping;
  };
  return {
    start() {
      wanted = true;
      if (inFlight.size === 0) worker.start();
    },
    async stop() {
      wanted = false;
      await stopWorker();
      await Promise.allSettled([...inFlight]);
    },
    whileHeld<T>(work: () => Promise<T>): Promise<T> {
      const held = (async () => {
        await stopWorker();
        return work();
      })();
      inFlight.add(held);
      const ended = (): void => {
        inFlight.delete(held);
        if (inFlight.size === 0 && wanted) worker.start();
      };
      held.then(ended, ended);
      return held;
    },
  };
}

/**
 * What one knowledge base's graph needs of itself to be STARTED: the boot
 * side effects that used to run inside `createCoreServer`, named so a host
 * can run them for a graph it builds on demand, and stop them again.
 */
export interface BootableCore {
  config: { workspacesRoot: string };
  kbDirName: string;
  kbStartupRunner: Pick<KbStartupRunner, 'runAll' | 'retryUntilMaintained'>;
  workflowService: Pick<WorkflowService, 'closeChangeRequestsWithDeletedBranches' | 'tidyAfterSweep'>;
  pluginJoinRequestJobs: Pick<PluginJoinRequestJobs, 'startSweeping'>;
  /**
   * The startup phase's retry, when the boot survived an unreachable remote
   * and is asking again on a timer; null otherwise. Set by {@link startCore},
   * stopped by {@link stopCore}.
   */
  startupRetry: { stop(): void } | null;
}

/**
 * Bring a built graph up: the distribution's boot hook, the note about what
 * sits beside a checkout, the knowledge-base startup phase with its
 * unreachable-remote fallback, the deleted-branch sweep and the join-request
 * jobs. `createCoreServer` runs this for a single-tenant deployment; a host
 * serving several knowledge bases runs it when a tenant is activated.
 *
 * Throws to stop the boot on every failure but the ones the host answered
 * about the repository or the credentials (see `bootMaySurvive`) — the
 * container's restart policy is the retry — see `kb-startup-runner.ts`.
 */
export async function startCore<C extends BootableCore>(
  core: C,
  ext: { onBoot?(core: C): Promise<void> | void } = {},
): Promise<void> {
  // Overlay boot-time side effects (startup reconciles, periodic sweeps).
  await ext.onBoot?.(core);

  // What is already sitting beside a checkout, named once per boot and touched
  // by nothing. Outside the KB startup phase below on purpose: that phase is
  // gated on the branch model and the repository URL, and a deployment whose
  // setup never finished — or whose remote is down — is exactly one whose
  // strays would otherwise go unmentioned. A diagnostic never stops a boot, so
  // an unreadable workspaces root is logged and the boot carries on.
  try {
    await noteBesideCheckout(core.config.workspacesRoot, core.kbDirName);
  } catch (err) {
    // `printable`, because the message quotes a path off the disk (an ENOENT
    // or EACCES names the file it failed on) and a name carrying a control
    // character would forge a second line of the operator's log.
    startupLog.warn('could not look for content beside the checkouts:', {
      detail: printable(err instanceof Error ? err.message : String(err)),
    });
  }

  // The KB startup phase — AFTER the distribution's onBoot, because a FATAL
  // template finding raised there must stop the boot before anything seeds
  // from that template; the runner then brings every branch up to this build
  // before any route can serve KB content. Throws to stop the boot (the
  // container's restart policy is the retry) — see kb-startup-runner.ts.
  //
  // Runs in the booting process whether or not it holds the commit-worker
  // lease, so on a redeploy it overlaps the outgoing holder's commits for the
  // seconds it takes — the documented window at `holdCommitWorkerLease`.
  try {
    await core.kbStartupRunner.runAll();
  } catch (err) {
    // The failures a boot survives: the host ANSWERED about the repository or
    // the credentials, or could not be reached at all. None of them says
    // anything about the knowledge base — what we would write is not known to
    // be wrong — and every one of them is fixed somewhere else: the host comes
    // back, the repository is created, the token is granted access, a rotated
    // token is typed into the setup screen. Refusing to boot took away the
    // login and setup screens the fix is entered on, and on 2026-09-28 a
    // repository that had been replaced crash-looped a deployment for exactly
    // that reason. The deployment comes up GATED instead: the setup routes
    // read the runner's standing failure and keep the app shut, the setup
    // screen shows why, saving it retries, and the runner keeps trying on its
    // own. Every other failure still stops the boot, because it means the
    // template or a step would write something wrong. See `bootMaySurvive`.
    if (!bootMaySurvive(err)) throw err;
    startupLog.error('booting UNMAINTAINED and gated — the knowledge base could not be initialized:', {
      detail: err instanceof Error ? err.message : String(err),
    });
    // Kept on the graph so that stopping the graph stops the asking: a
    // retry that outlived its graph would clone into a workspaces folder
    // nobody serves any more.
    core.startupRetry = core.kbStartupRunner.retryUntilMaintained();
  }

  // Close change requests whose source branch has been deleted. SEQUENCED
  // AFTER the startup phase above, for two reasons: the sweep's fresh fetch
  // lazily bootstraps and fetches the same default-branch clone the runner
  // maintains (kicking it off earlier races the runner's clone/fetch of that
  // very directory), and on a brand-new deployment it would run before the
  // empty remote is seeded, fail its clone, swallow the error, and leave
  // deleted-branch CRs open for the whole process. Still not awaited from
  // here on: a slow or unreachable remote must not hold up the server —
  // nothing downstream depends on the result, and the requests it closes
  // have been unusable since the branch went away, so landing a few seconds
  // into uptime is soon enough. Errors are swallowed inside the sweep, which
  // fails safe by closing nothing.
  void core.workflowService
    .closeChangeRequestsWithDeletedBranches()
    .then((n) => {
      if (n > 0) {
        crLog.info(`closed ${n} change request${n === 1 ? '' : 's'} with a deleted branch`);
      }
    })
    .catch((err) => crLog.warn('deleted-branch sweep failed:', { err }))
    // Then the tidy-up: open requests that propose nothing are closed, and the
    // branches merged requests left behind removed (behind its own setting).
    // Fails safe on a failed fetch, and never throws.
    .then(() => core.workflowService.tidyAfterSweep());

  // Recorded join requests that are still owed, resumed — now, and then on a
  // timer. SEQUENCED AFTER the startup phase for the same reason as the sweep
  // above: the work needs the default-branch clone the runner maintains and
  // the plugin catalog read from it, and a sweep that ran first would refuse
  // every row for a knowledge base that simply was not ready — telling people
  // their request could not be sent when nothing had gone wrong with it.
  //
  // ON A TIMER rather than at boot alone, because boot cannot cover the
  // redeploy: this process sweeps while the outgoing one still holds a
  // record, skips it (correctly — two servers must not do git on one branch),
  // and the outgoing process then exits mid-work. Nothing else would look at
  // that row again. The requester cannot prompt it either: a pending record
  // shows them the "Requested" card, not a button.
  //
  // Not awaited, and nothing to report here but the failure to read the table
  // at all: a first request from a person is a full clone, nothing else at
  // boot depends on it, and each row records its own outcome.
  core.pluginJoinRequestJobs.startSweeping();
}

/**
 * What one knowledge base's graph holds that must be let go of when it
 * stops: the pieces {@link stopCore} winds down, in the order it winds
 * them down. `createShutdown` takes the same, plus the listening server.
 */
export interface CoreStopDeps {
  /** The lease loop from {@link holdCommitWorkerLease}: its stop finishes the in-flight commit and releases the lease. */
  commitWorker: Pick<LeaseLoopHandle, 'stop'>;
  /**
   * Background work to wind down before the pool goes — the join-request
   * sweep and its jobs, today. The timer is stopped first so nothing new is
   * scheduled, then the jobs already running are awaited (within the budget)
   * so the pool is not ended under a clone or a push that is still writing
   * to it. Optional: a caller that has not built them yet passes nothing.
   */
  backgroundJobs?: { stopSweeping(): void; drain(): Promise<void> };
  /**
   * The agent upload store, whose own sweep deletes staged bytes nobody
   * applied. Stopped with this graph because the next graph for the same
   * tenant stages into the SAME directory with an empty record map: a sweep
   * left running from a store that is gone would read the replacement's files
   * as orphans and delete them under an apply that is about to read them.
   * Optional: a caller that has not built one passes nothing.
   */
  agentUploadStore?: { stopSweeping(): void; drainSweep(): Promise<void> };
  /** The agent download store, whose sweep deletes captured bytes nobody fetched — stopped for the same reason. */
  agentDownloadStore?: { stopSweeping(): void; drainSweep(): Promise<void> };
  /** The startup phase's retry, if the boot left one asking — see {@link BootableCore.startupRetry}. */
  startupRetry?: { stop(): void } | null;
  /** The database — its pool is ended last, once nothing above can still need it. */
  db: Pick<Database, '$client'>;
  /**
   * The scope this graph's secrets vault was registered under with the UTCP
   * variable loader (see `secrets-variable-loader.ts`); forgotten on stop so
   * a descriptor that outlives the graph resolves nothing. Optional: a
   * single-tenant process exits right after, and has nothing to forget.
   */
  secretsScope?: string;
  log?: (message: string) => void;
}

export interface ShutdownDeps extends CoreStopDeps {
  /** The listening server — stops accepting, then drops what is connected. */
  server: Pick<Server, 'close' | 'closeAllConnections'>;
}

export interface ShutdownOptions {
  /**
   * Total time the sequence may take. Default 8s: Docker's `stop_grace_period`
   * is 10s and none of the compose files raise it, so past that the container
   * is killed anyway, and a sequence still running then has achieved nothing
   * a kill would not.
   */
  deadlineMs?: number;
}

const DEFAULT_SHUTDOWN_DEADLINE_MS = 8_000;

/** Await `promise` for at most `ms`; on expiry log and move on rather than hang the exit. */
async function bounded(promise: Promise<unknown>, ms: number, label: string, log: (m: string) => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), Math.max(0, ms));
  });
  try {
    const outcome = await Promise.race([promise.then(() => 'done' as const), expired]);
    if (outcome === 'expired') log(`${label} did not finish within ${ms}ms — continuing the shutdown`);
  } catch (err) {
    log(`${label} failed: ${String(err)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The shutdown sequence, as a function the process's signal handlers call.
 * Idempotent: a second signal awaits the sequence already running rather than
 * starting another.
 *
 * The order is the point:
 *
 *   1. Stop accepting, and drop every open connection. SSE streams end here;
 *      the browser's EventSource reconnects on its own, and the replacement
 *      process — whose replay buffer is empty — answers the reconnect with a
 *      resync, which is the behaviour the event bus already defines for it.
 *      No stream is told anything, because nothing it could be told would
 *      beat that.
 *   2. Stop the commit worker, which finishes the commit it is in the middle
 *      of, then release the lease so the replacement can take it. A commit
 *      that cannot finish inside the deadline is abandoned as `running` in the
 *      queue, and the startup reconcile of the next boot returns it to
 *      `pending` — the recovery the queue has always had for a process that
 *      died mid-commit, now the exception rather than the rule.
 *   3. End the pool.
 */
/**
 * Let go of everything a graph holds, in order, within `remaining()`.
 * The order is the point — see {@link createShutdown} for why each step
 * sits where it does.
 */
async function releaseCore(deps: CoreStopDeps, remaining: () => number, log: (m: string) => void): Promise<void> {
  // First, and BEFORE the commit worker is stopped. Stopping that worker
  // awaits an in-flight commit and can spend most of the remaining budget
  // doing it; a sweep tick firing inside that window reads the still-open
  // pool and starts fresh clone/commit/push work that the end of the
  // sequence then kills mid-git. Nothing new can be recorded once the
  // server is closed (or the tenant is no longer routed to), so this is the
  // earliest point the interval is dead weight. Synchronous and unfailing
  // — it just clears an interval — so it needs no budget of its own.
  deps.backgroundJobs?.stopSweeping();
  // And the upload store's sweep, for the same reason and in the same breath:
  // synchronous, and it only clears an interval and tells a sweep already
  // running to stop deleting.
  deps.agentUploadStore?.stopSweeping();
  deps.agentDownloadStore?.stopSweeping();
  // A startup phase still asking for an unreachable remote stops asking:
  // synchronous, and nothing after it must be able to clone into a
  // workspaces folder that is about to belong to nobody.
  deps.startupRetry?.stop();
  // Clearing the interval stops future ticks; it does nothing to a job a
  // tick already started, which holds a claim it heartbeats through the
  // pool and is mid-clone or mid-push. Awaited here, in the budget: a job
  // that finishes releases or marks its row; one that cannot in time is
  // killed with the process and its claim goes stale for the next sweep
  // — which is the recovery every crash already gets.
  if (deps.backgroundJobs) {
    await bounded(deps.backgroundJobs.drain(), remaining(), 'finishing the background jobs', log);
  }
  // The sweep in flight when the interval was cleared: awaited so the next
  // graph for this tenant cannot start staging bytes while a store it has
  // never heard of is still walking the same directory.
  if (deps.agentUploadStore) {
    await bounded(deps.agentUploadStore.drainSweep(), remaining(), 'finishing the upload sweep', log);
  }
  if (deps.agentDownloadStore) {
    await bounded(deps.agentDownloadStore.drainSweep(), remaining(), 'finishing the download sweep', log);
  }
  await bounded(deps.commitWorker.stop(), remaining(), 'stopping the commit worker', log);
  if (deps.secretsScope !== undefined) unregisterBevelSecretsVariableLoader(deps.secretsScope);
  await bounded(closeDb(deps.db), remaining(), 'ending the database pool', log);
}

export interface StopCoreOptions {
  /** Total time the stop may take. Default: the shutdown's 8s. */
  deadlineMs?: number;
}

/**
 * Stop one knowledge base's graph without stopping the process: the
 * shutdown sequence minus closing the server. What a host runs when it
 * evicts a tenant, and what {@link createShutdown} runs after the server
 * has closed. Bounded like the shutdown, so a step that hangs cannot hold
 * the host's event loop hostage.
 */
export async function stopCore(core: CoreStopDeps, opts: StopCoreOptions = {}): Promise<void> {
  const log = core.log ?? ((message: string) => logger('lifecycle').info(message));
  const deadlineMs = opts.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
  const startedAt = Date.now();
  const remaining = () => Math.max(0, deadlineMs - (Date.now() - startedAt));
  await releaseCore(core, remaining, log);
  log(`graph stopped in ${Date.now() - startedAt}ms`);
}

export function createShutdown(
  deps: ShutdownDeps,
  opts: ShutdownOptions = {},
): (reason: string) => Promise<void> {
  const log = deps.log ?? ((message: string) => logger('lifecycle').info(message));
  const deadlineMs = opts.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
  let inFlight: Promise<void> | null = null;

  return (reason: string) => {
    inFlight ??= (async () => {
      const startedAt = Date.now();
      const remaining = () => Math.max(0, deadlineMs - (Date.now() - startedAt));
      log(`shutting down: ${reason}`);

      await bounded(
        new Promise<void>((resolve) => {
          deps.server.close(() => resolve());
          deps.server.closeAllConnections();
        }),
        remaining(),
        'closing the server',
        log,
      );
      await releaseCore(deps, remaining, log);

      log(`shutdown complete in ${Date.now() - startedAt}ms`);
    })();
    return inFlight;
  };
}
