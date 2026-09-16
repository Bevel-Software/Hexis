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

export interface PeriodicTaskOptions {
  /** Names the task in its log lines. */
  label: string;
  /** Time between the end of one run and the start of the next. */
  intervalMs: number;
  /** Time before the first run; defaults to `intervalMs`. */
  initialDelayMs?: number;
  /** Test seam — defaults to `setTimeout` wrapped as a promise. */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * A housekeeping job as a {@link LeasedWorker}, so it runs exactly where the
 * commit worker runs: in the one process holding the lease. Anything that
 * touches the shared clone volume on a timer belongs here rather than on a
 * bare `setInterval`, for the same reason the commit worker does — two
 * processes overlap on every redeploy, and two sweeps of one volume is the
 * interleaving the lease exists to rule out.
 *
 * A run that throws is logged and the schedule continues; a `stop()` during
 * a run awaits the run, and one during the wait ends the wait at once.
 */
export function periodicTask(run: () => Promise<void>, opts: PeriodicTaskOptions): LeasedWorker {
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((message: string) => logger('lifecycle').info(message));
  const initialDelayMs = opts.initialDelayMs ?? opts.intervalMs;

  let running = false;
  let loop: Promise<void> | null = null;
  let wake: (() => void) | null = null;

  const wait = (ms: number) =>
    Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
    ]).finally(() => {
      wake = null;
    });

  return {
    start() {
      if (running) return;
      running = true;
      loop = (async () => {
        await wait(initialDelayMs);
        while (running) {
          try {
            await run();
          } catch (err) {
            log(`${opts.label} failed: ${String(err)}`);
          }
          if (running) await wait(opts.intervalMs);
        }
      })();
    },
    async stop() {
      if (!running) return;
      running = false;
      wake?.();
      await loop;
      loop = null;
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

/**
 * Several workers as one, for the lease loop: all start when the lease is
 * taken, all stop when it is lost or the process ends. A stop is awaited
 * for every member even when one of them fails to stop.
 */
export function leasedWorkers(...workers: LeasedWorker[]): LeasedWorker {
  return {
    start() {
      for (const worker of workers) worker.start();
    },
    async stop() {
      const outcomes = await Promise.allSettled(workers.map((worker) => worker.stop()));
      const failed = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected');
      if (failed) throw failed.reason;
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
