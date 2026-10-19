import type { Worker } from 'node:worker_threads';

/**
 * The pooled worker threads that keep CPU-bound work off the request thread:
 * the mechanics every worker kind shares, whatever its worker runs. Two kinds
 * use it today, each with a pool of its own — the regex matcher `grep` runs a
 * caller's pattern in (`bounded-matcher.ts`) and the document extractor every
 * office, PDF and email extraction runs in (`file-readers/extract-in-worker.ts`).
 *
 * What a kind brings is how to start its worker; what the pool owns is the
 * rest: at most `poolMax` workers, a capped queue of jobs waiting for one,
 * idle workers that never hold a process's exit open, a worker that dies (or
 * is discarded over its budget) leaving the pool and being replaced for the
 * next waiting job, and `close()`, which ends them all.
 *
 * The owner of a pool is its kind's instance, and the owner of that is the
 * composition root, which closes it when the graph stops (`lifecycle.ts`), so
 * no worker outlives what it served.
 */
export interface WorkerPoolSizing {
  /** Workers kept at once; a job past this waits for one to free up. */
  poolMax: number;
  /** Jobs that may wait for a worker at once; past it `acquire` refuses with the kind's busy error. */
  maxWaiting: number;
}

type Waiter = { resolve: (w: Worker) => void; reject: (err: Error) => void };

export class WorkerPool {
  private readonly idle: Worker[] = [];
  private readonly all = new Set<Worker>();
  private readonly waiting: Waiter[] = [];
  private closed = false;

  constructor(
    /** Starts one worker of this pool's kind. */
    private readonly spawnWorker: () => Worker,
    private readonly sizing: WorkerPoolSizing,
    /** The kind's answer for "no worker now, and no room to wait for one" (and for any job after `close`). */
    private readonly busy: () => Error,
  ) {}

  /** A worker for one job, given back with `release` — or, when it must not be reused, `discard`. */
  async acquire(): Promise<Worker> {
    if (this.closed) throw this.busy();
    if (this.idle.length === 0 && this.all.size >= this.sizing.poolMax && this.waiting.length >= this.sizing.maxWaiting) {
      throw this.busy();
    }
    const w =
      this.idle.pop() ??
      (this.all.size < this.sizing.poolMax
        ? this.spawn()
        : await new Promise<Worker>((resolve, reject) => this.waiting.push({ resolve, reject })));
    w.ref();
    return w;
  }

  /** A worker whose job ended cleanly goes to the next waiting job, or idles. */
  release(w: Worker): void {
    const next = this.waiting.shift();
    if (next) return next.resolve(w);
    // An idle worker must not hold a process's exit open.
    w.unref();
    this.idle.push(w);
  }

  /**
   * A worker that must not run another job — over its budget, or left in a
   * state its job cannot vouch for — is terminated. Terminating is what stops
   * a thread mid-computation; its exit takes it out of the pool and hands a
   * fresh worker to the next waiting job.
   */
  discard(w: Worker): void {
    void w.terminate();
  }

  /** Ends every worker; a job waiting, or asking after this, is answered busy. */
  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter.reject(this.busy());
    const workers = [...this.all];
    this.idle.length = 0;
    await Promise.all(workers.map((w) => w.terminate()));
  }

  private spawn(): Worker {
    const w = this.spawnWorker();
    this.all.add(w);
    // A worker that dies — terminated over budget, or out of memory — leaves the pool.
    w.once('exit', () => {
      this.all.delete(w);
      const at = this.idle.indexOf(w);
      if (at >= 0) this.idle.splice(at, 1);
      if (this.closed) return;
      const next = this.waiting.shift();
      if (next) next.resolve(this.spawn());
    });
    return w;
  }
}

/**
 * How one message to a worker ended: its reply; the timeout, with the worker
 * still running (the caller decides whether to discard it); an error the
 * worker raised and did not catch; or the worker's exit before it answered.
 */
export type Exchange<R> = { reply: R } | { timeout: true } | { error: Error } | { exited: number };

/**
 * Post `message` to `w` and wait at most `timeoutMs` for its one reply.
 * `transfer` hands buffers over without copying them on this thread. Never
 * rejects: every way the exchange can end is an {@link Exchange} the caller
 * maps to its own answer, and every listener it adds is removed however it
 * ends.
 */
export function exchange<R>(
  w: Worker,
  message: unknown,
  timeoutMs: number,
  transfer: readonly ArrayBuffer[] = [],
): Promise<Exchange<R>> {
  return new Promise((resolve) => {
    const settle = (outcome: Exchange<R>) => {
      clearTimeout(timer);
      w.off('message', onMessage);
      w.off('error', onError);
      w.off('exit', onExit);
      resolve(outcome);
    };
    const onMessage = (reply: R) => settle({ reply });
    const onError = (error: Error) => settle({ error });
    const onExit = (code: number) => settle({ exited: code });
    const timer = setTimeout(() => settle({ timeout: true }), timeoutMs);
    w.on('message', onMessage);
    w.on('error', onError);
    w.on('exit', onExit);
    try {
      w.postMessage(message, transfer as ArrayBuffer[]);
    } catch (err) {
      // A message that cannot be cloned is this exchange's error, not a throw.
      settle({ error: err instanceof Error ? err : new Error(String(err)) });
    }
  });
}

/**
 * The longest delay `setTimeout` honours. A longer one fires after 1 ms, so a
 * budget past this would stop every job at once.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/** A sizing option as given, refused at construction unless it is an integer from `min` to `max`. */
export function sizingOption(owner: string, name: string, value: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${owner}: ${name} must be an integer from ${min} to ${max}, got ${value}.`);
  }
  return value;
}
