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

export interface ShutdownDeps {
  /** The listening server — stops accepting, then drops what is connected. */
  server: Pick<Server, 'close' | 'closeAllConnections'>;
  /** The lease loop from {@link holdCommitWorkerLease}: its stop finishes the in-flight commit and releases the lease. */
  commitWorker: Pick<LeaseLoopHandle, 'stop'>;
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
      await bounded(deps.commitWorker.stop(), remaining(), 'stopping the commit worker', log);
      await bounded(deps.db.$client.end(), remaining(), 'ending the database pool', log);

      log(`shutdown complete in ${Date.now() - startedAt}ms`);
    })();
    return inFlight;
  };
}
