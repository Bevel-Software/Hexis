import type { Server } from 'node:http';
import type { Database } from '../modules/database/connection.js';
import type { AdvisoryLease } from '../modules/database/advisory-lock.js';
import { logger } from '../shared/logging.js';

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
        await stopWorker();
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

export interface ShutdownDeps {
  /** The listening server — stops accepting, then drops what is connected. */
  server: Pick<Server, 'close' | 'closeAllConnections'>;
  /** The lease loop from {@link holdCommitWorkerLease}: its stop finishes the in-flight commit and releases the lease. */
  commitWorker: Pick<LeaseLoopHandle, 'stop'>;
  /**
   * Background work to wind down before the pool goes — the join-request
   * sweep and its jobs, today. The timer is stopped after the server so
   * nothing new is scheduled, then the jobs already running are awaited
   * (within the budget) so the pool is not ended under a clone or a push
   * that is still writing to it. Optional: a caller that has not built them
   * yet passes nothing.
   */
  backgroundJobs?: { stopSweeping(): void; drain(): Promise<void> };
  /** The database — its pool is ended last, once nothing above can still need it. */
  db: Pick<Database, '$client'>;
  log?: (message: string) => void;
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
      // Immediately after the server, and BEFORE the commit worker is stopped.
      // Stopping that worker awaits an in-flight commit and can spend most of
      // the remaining budget doing it; a sweep tick firing inside that window
      // reads the still-open pool and starts fresh clone/commit/push work that
      // the `process.exit()` at the end of the sequence then kills mid-git.
      // Nothing new can be recorded once the server is closed, so this is the
      // earliest point the interval is dead weight. Synchronous and unfailing
      // — it just clears an interval — so it needs no budget of its own.
      deps.backgroundJobs?.stopSweeping();
      // Clearing the interval stops future ticks; it does nothing to a job a
      // tick already started, which holds a claim it heartbeats through the
      // pool and is mid-clone or mid-push. Awaited here, in the budget: a job
      // that finishes releases or marks its row; one that cannot in time is
      // killed with the process and its claim goes stale for the next sweep
      // — which is the recovery every crash already gets.
      if (deps.backgroundJobs) {
        await bounded(deps.backgroundJobs.drain(), remaining(), 'finishing the background jobs', log);
      }
      await bounded(deps.commitWorker.stop(), remaining(), 'stopping the commit worker', log);
      await bounded(deps.db.$client.end(), remaining(), 'ending the database pool', log);

      log(`shutdown complete in ${Date.now() - startedAt}ms`);
    })();
    return inFlight;
  };
}
