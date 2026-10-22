import { Worker } from 'node:worker_threads';
import { ToolError } from '../tool-helpers/index.js';
import {
  type IPatternMatcher,
  type IPatternSearch,
  PatternTooExpensiveError,
  SearchBusyError,
} from './pattern-matcher.contract.js';

/**
 * The one place a CALLER'S regular expression is run (see
 * {@link IPatternMatcher}).
 *
 * The pattern never runs on the request thread: the lines go to a worker, the
 * worker answers which of them match, and a search whose matching outlives its
 * budget has its worker terminated (which interrupts even a regex
 * mid-backtrack) and is answered with {@link PatternTooExpensiveError}.
 * Nothing partial is returned: a search that blew its budget answers the 400
 * alone.
 *
 * The semantics are the engine's own — the worker compiles the same source with
 * the same flags and calls `test` on each line — so a pattern within budget
 * matches exactly the lines it always did.
 *
 * The pool is this instance's own: the composition root builds one per graph
 * and closes it when the graph stops, so no worker outlives what it served.
 */
export interface WorkerPatternMatcherOptions {
  /** Matching time one search may spend, summed over every file it searches. Default 5 s. */
  budgetMs?: number;
  /** Workers kept for searches at once; a search past this waits for one to free up. Default 4. */
  poolMax?: number;
  /**
   * Searches that may wait for a worker at once. A waiting search holds the
   * lines it was handed, so the queue is capped: past it a search is refused
   * with a 503 rather than piling file contents up in memory. Default 16.
   */
  maxWaiting?: number;
  /**
   * Longest pattern accepted. The pattern is compiled on the request thread
   * (that is how a syntax error earns its 400 there), so its length is what
   * bounds that. Default 1000.
   */
  maxPatternLength?: number;
  /**
   * Characters handed to the worker in one message. Posting a message copies
   * it on the request thread, so a large file goes over in pieces of about
   * this size rather than in one copy that would stall every other request.
   * A single line longer than this is not posted at all: it is written into
   * shared memory this many characters at a time, yielding between pieces,
   * and the worker reads it from there. Default 1 MB.
   */
  batchChars?: number;
  /**
   * Lines handed to the worker in one message. Each line is an entry the
   * copy has to walk whatever its length, so a file of empty lines is bounded
   * by this, not by `batchChars`. Default 10,000.
   */
  batchLines?: number;
}

/**
 * Slack on top of the remaining budget before a batch is given up on: the
 * budget counts only the worker's own matching time, so handing the lines over
 * and the answer back must not be what trips it.
 */
const TRANSFER_GRACE_MS = 250;

/** The worker: compiles the pattern it is handed and answers the indices of the lines it matches. */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
let cached = { key: null, re: null };
parentPort.on('message', ({ source, flags, lines, shared, limit }) => {
  try {
    // One line too long to post, written into shared memory as raw UTF-16 code units.
    if (shared) lines = [Buffer.from(shared).toString('utf16le')];
    const key = flags + '/' + source;
    if (cached.key !== key) cached = { key, re: new RegExp(source, flags) };
    const re = cached.re;
    const started = performance.now();
    const hits = [];
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) hits.push(i);
    }
    parentPort.postMessage({ hits, elapsed: performance.now() - started });
  } catch (err) {
    parentPort.postMessage({ error: String(err && err.message ? err.message : err) });
  }
});
`;

type Reply = { hits: number[]; elapsed: number } | { error: string };
/** What a search borrows from its pool: a worker, its return, and where a batch ends. */
type Lease = {
  acquire(): Promise<Worker>;
  release(w: Worker): void;
  batchEnd(lines: string[], from: number): number;
  readonly batchChars: number;
};
type Waiter = { resolve: (w: Worker) => void; reject: (err: Error) => void };

export class WorkerPatternMatcher implements IPatternMatcher {
  private readonly budgetMs: number;
  private readonly poolMax: number;
  private readonly maxWaiting: number;
  private readonly maxPatternLength: number;
  private readonly batchChars: number;
  private readonly batchLines: number;
  private readonly idle: Worker[] = [];
  private readonly all = new Set<Worker>();
  private readonly waiting: Waiter[] = [];
  private closed = false;
  private readonly lease: Lease;

  constructor(opts: WorkerPatternMatcherOptions = {}) {
    this.budgetMs = option('budgetMs', opts.budgetMs ?? 5_000, 1, MAX_TIMER_MS - TRANSFER_GRACE_MS);
    // A pool of none would leave every search waiting for a worker that never comes.
    this.poolMax = option('poolMax', opts.poolMax ?? 4, 1);
    // No queue at all is allowed: every search past the pool is refused busy.
    this.maxWaiting = option('maxWaiting', opts.maxWaiting ?? 16, 0);
    this.maxPatternLength = option('maxPatternLength', opts.maxPatternLength ?? 1_000, 1);
    this.batchChars = option('batchChars', opts.batchChars ?? 1_000_000, 1);
    this.batchLines = option('batchLines', opts.batchLines ?? 10_000, 1);
    this.lease = {
      acquire: () => this.acquire(),
      release: (w) => this.release(w),
      batchEnd: (lines, from) => this.batchEnd(lines, from),
      batchChars: this.batchChars,
    };
  }

  search(source: string, flags: string): IPatternSearch {
    if (source.length > this.maxPatternLength) {
      throw new ToolError(
        `Pattern too long: ${source.length} characters, and a search pattern may have at most ${this.maxPatternLength}.`,
        400,
        { code: 'pattern_too_long' },
      );
    }
    try {
      new RegExp(source, flags);
    } catch (err) {
      throw new ToolError(`Invalid regex: ${(err as Error).message}`, 400);
    }
    return new BoundedSearch(this.lease, source, flags, this.budgetMs);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter.reject(new SearchBusyError());
    const workers = [...this.all];
    this.idle.length = 0;
    await Promise.all(workers.map((w) => w.terminate()));
  }

  /**
   * Where the batch starting at `from` ends: about `batchChars` characters on,
   * at most `batchLines` lines on, and never empty. A batch of one line past
   * `batchChars` is handed over through shared memory instead (see
   * {@link BoundedSearch.matchBatch}).
   */
  private batchEnd(lines: string[], from: number): number {
    let to = from;
    let chars = 0;
    const last = Math.min(lines.length, from + this.batchLines);
    while (to < last && (to === from || chars + lines[to]!.length <= this.batchChars)) chars += lines[to++]!.length;
    return to;
  }

  private async acquire(): Promise<Worker> {
    if (this.closed) throw new SearchBusyError();
    if (this.idle.length === 0 && this.all.size >= this.poolMax && this.waiting.length >= this.maxWaiting) {
      throw new SearchBusyError();
    }
    const w =
      this.idle.pop() ??
      (this.all.size < this.poolMax
        ? this.spawn()
        : await new Promise<Worker>((resolve, reject) => this.waiting.push({ resolve, reject })));
    w.ref();
    return w;
  }

  private release(w: Worker): void {
    const next = this.waiting.shift();
    if (next) return next.resolve(w);
    // An idle worker must not hold a process's exit open.
    w.unref();
    this.idle.push(w);
  }

  private spawn(): Worker {
    const w = new Worker(WORKER_SOURCE, { eval: true });
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

/** One search: a caller's pattern, matched off the event loop under one budget. */
class BoundedSearch implements IPatternSearch {
  private spentMs = 0;

  constructor(
    private readonly pool: Lease,
    private readonly source: string,
    private readonly flags: string,
    private readonly budgetMs: number,
  ) {}

  async matchingLines(lines: string[], limit: number): Promise<number[]> {
    if (limit <= 0 || lines.length === 0) return [];
    if (this.spentMs >= this.budgetMs) throw new PatternTooExpensiveError(this.source, this.budgetMs);
    const w = await this.pool.acquire();
    const hits: number[] = [];
    try {
      for (let from = 0; from < lines.length && hits.length < limit; ) {
        const to = this.pool.batchEnd(lines, from);
        for (const i of await this.matchBatch(w, lines.slice(from, to), limit - hits.length)) hits.push(from + i);
        from = to;
      }
    } catch (err) {
      // Terminating is what stops a regex mid-backtrack; the pool replaces it.
      void w.terminate();
      throw err;
    }
    this.pool.release(w);
    return hits;
  }

  /**
   * One handoff to the worker, charged to this search's budget. No handoff
   * copies more than `batchChars` characters on the request thread at once: a
   * line longer than that goes over in shared memory, not in the message.
   */
  private async matchBatch(w: Worker, lines: string[], limit: number): Promise<number[]> {
    if (this.spentMs >= this.budgetMs) throw new PatternTooExpensiveError(this.source, this.budgetMs);
    const oversized = lines.length === 1 && lines[0]!.length > this.pool.batchChars;
    const payload = oversized ? { shared: await shareLine(w, lines[0]!, this.pool.batchChars) } : { lines };
    const remaining = this.budgetMs - this.spentMs;
    const reply = await run(w, { source: this.source, flags: this.flags, ...payload, limit }, remaining + TRANSFER_GRACE_MS);
    if (reply === 'timeout') {
      this.spentMs = this.budgetMs;
      throw new PatternTooExpensiveError(this.source, this.budgetMs);
    }
    if ('error' in reply) throw new ToolError(`Invalid regex: ${reply.error}`, 400);
    this.spentMs += reply.elapsed;
    if (this.spentMs > this.budgetMs) throw new PatternTooExpensiveError(this.source, this.budgetMs);
    return reply.hits;
  }
}

/**
 * A line as raw UTF-16 code units in shared memory, which a message hands the
 * worker without copying. It is written `chunkChars` at a time with a turn of
 * the event loop between, so a line of any length never holds the request
 * thread for longer than one chunk. Raw code units keep the line exact, lone
 * surrogates included.
 *
 * The worker it is meant for can be terminated by `close()` during those turns,
 * before {@link run} listens for its exit; a message posted to it then would
 * never be answered. So its exit is watched here too: writing stops and the
 * search is answered busy, as one terminated under `run` is.
 */
async function shareLine(w: Worker, line: string, chunkChars: number): Promise<SharedArrayBuffer> {
  let exited = false;
  const onExit = () => {
    exited = true;
  };
  w.once('exit', onExit);
  try {
    const shared = new SharedArrayBuffer(line.length * 2);
    const bytes = Buffer.from(shared);
    for (let at = 0; at < line.length && !exited; at += chunkChars) {
      if (at > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      bytes.write(line.slice(at, at + chunkChars), at * 2, 'utf16le');
    }
    if (exited) throw new SearchBusyError();
    return shared;
  } finally {
    w.off('exit', onExit);
  }
}

function run(w: Worker, message: object, timeoutMs: number): Promise<Reply | 'timeout'> {
  return new Promise((resolve, reject) => {
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      w.off('message', onMessage);
      w.off('error', onError);
      w.off('exit', onExit);
      fn();
    };
    const onMessage = (reply: Reply) => settle(() => resolve(reply));
    const onError = (err: Error) => settle(() => reject(err));
    // Terminated under the search by `close()`: answered as busy, not left hanging until the timer.
    const onExit = () => settle(() => reject(new SearchBusyError()));
    const timer = setTimeout(() => settle(() => resolve('timeout')), timeoutMs);
    w.on('message', onMessage);
    w.on('error', onError);
    w.on('exit', onExit);
    w.postMessage(message);
  });
}

/**
 * The longest delay `setTimeout` honours. A longer one fires after 1 ms, so a
 * budget past this (less the grace added to it) would stop every search at once.
 */
const MAX_TIMER_MS = 2_147_483_647;

/** A sizing option as given, refused at construction unless it is an integer from `min` to `max`. */
function option(name: string, value: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`WorkerPatternMatcher: ${name} must be an integer from ${min} to ${max}, got ${value}.`);
  }
  return value;
}
