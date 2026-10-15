import { Worker } from 'node:worker_threads';
import { ToolError } from '../tool-helpers/tool.contract.js';

/**
 * The one place a CALLER'S regular expression is run.
 *
 * JavaScript's engine backtracks, so a pattern like `^(a+)+$` over a line of
 * forty `a`s and a `!` takes longer than the universe has left — and run on the
 * request thread it holds the event loop for every user while it does. So the
 * pattern never runs on that thread: the lines go to a worker, the worker
 * answers which of them match, and a search whose matching outlives
 * {@link PATTERN_BUDGET_MS} has its worker terminated (which interrupts even a
 * regex mid-backtrack) and is answered with {@link PatternTooExpensiveError}.
 * Nothing partial is returned: a search that blew its budget answers the 400
 * alone.
 *
 * The semantics are the engine's own — the worker compiles the same source with
 * the same flags and calls `test` on each line — so a pattern within budget
 * matches exactly the lines it always did.
 */

/** Matching time one search may spend, summed over every file it searches. */
export const PATTERN_BUDGET_MS = 5_000;
/**
 * Slack on top of the remaining budget before a batch is given up on: the
 * budget counts only the worker's own matching time, so handing the lines over
 * and the answer back must not be what trips it.
 */
const TRANSFER_GRACE_MS = 250;
/** Workers kept for searches at once; a search past this waits for one to free up. */
const POOL_MAX = 4;
/**
 * Searches that may wait for a worker at once. A waiting search holds the lines
 * it was handed, so the queue is capped: past it a search is refused with a 503
 * rather than piling file contents up in memory.
 */
export const MAX_WAITING = 16;
/**
 * Longest pattern accepted. The pattern is compiled on the request thread (that
 * is how a syntax error earns its 400 there), so its length is what bounds that.
 */
export const MAX_PATTERN_LENGTH = 1_000;
/**
 * Characters handed to the worker in one message. Posting a message copies it
 * on the request thread, so a large file goes over in pieces of about this size
 * rather than in one copy that would stall every other request.
 */
export const BATCH_CHARS = 1_000_000;

/** A pattern stopped for taking too long — a 400, worded for the caller. */
export class PatternTooExpensiveError extends ToolError {
  constructor(pattern: string, budgetMs: number) {
    super(
      `Pattern too expensive: /${pattern.length > 80 ? `${pattern.slice(0, 80)}…` : pattern}/ did not finish matching within this search's ${budgetMs / 1000} s budget, ` +
        'so it was stopped and nothing was returned. Patterns with nested or overlapping repetition such as ' +
        '`(a+)+` or `(a|aa)*` can take exponential time on some lines. Use a simpler pattern — a literal, ' +
        'an anchor, a character class, a single repetition — or narrow `path`.',
      400,
      { code: 'pattern_too_expensive' },
    );
    this.name = 'PatternTooExpensiveError';
  }
}

/** The worker: compiles the pattern it is handed and answers the indices of the lines it matches. */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
let cached = { key: null, re: null };
parentPort.on('message', ({ source, flags, lines, limit }) => {
  try {
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

const idle: Worker[] = [];
let live = 0;
const waiting: ((w: Worker) => void)[] = [];

function spawn(): Worker {
  live++;
  const w = new Worker(WORKER_SOURCE, { eval: true });
  // A worker that dies on its own (out of memory) leaves the pool.
  w.once('exit', () => {
    live--;
    const at = idle.indexOf(w);
    if (at >= 0) idle.splice(at, 1);
    const next = waiting.shift();
    if (next) next(spawn());
  });
  return w;
}

async function acquire(): Promise<Worker> {
  if (idle.length === 0 && live >= POOL_MAX && waiting.length >= MAX_WAITING) {
    throw new ToolError('Too many searches are running at once; try again in a few seconds.', 503, {
      code: 'search_busy',
    });
  }
  const w = idle.pop() ?? (live < POOL_MAX ? spawn() : await new Promise<Worker>((resolve) => waiting.push(resolve)));
  w.ref();
  return w;
}

function release(w: Worker): void {
  const next = waiting.shift();
  if (next) return next(w);
  // An idle worker must not hold a process's exit open.
  w.unref();
  idle.push(w);
}

function run(w: Worker, message: object, timeoutMs: number): Promise<Reply | 'timeout'> {
  return new Promise((resolve, reject) => {
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      w.off('message', onMessage);
      w.off('error', onError);
      fn();
    };
    const onMessage = (reply: Reply) => settle(() => resolve(reply));
    const onError = (err: Error) => settle(() => reject(err));
    const timer = setTimeout(() => settle(() => resolve('timeout')), timeoutMs);
    w.on('message', onMessage);
    w.on('error', onError);
    w.postMessage(message);
  });
}

/**
 * A caller's pattern, matched off the event loop under one search's budget.
 * One instance per search: the budget is spent across every call to
 * {@link matchingLines} it makes.
 */
export class BoundedMatcher {
  private spentMs = 0;

  /**
   * Throws the 400 `Invalid regex` the caller's syntax earns, or the 400 an
   * over-long pattern earns, before any worker is involved.
   */
  constructor(
    private readonly source: string,
    private readonly flags: string,
    private readonly budgetMs: number = PATTERN_BUDGET_MS,
  ) {
    if (source.length > MAX_PATTERN_LENGTH) {
      throw new ToolError(
        `Pattern too long: ${source.length} characters, and a search pattern may have at most ${MAX_PATTERN_LENGTH}.`,
        400,
        { code: 'pattern_too_long' },
      );
    }
    try {
      new RegExp(source, flags);
    } catch (err) {
      throw new ToolError(`Invalid regex: ${(err as Error).message}`, 400);
    }
  }

  /**
   * The indices of the lines the pattern matches, in order, at most `limit` of
   * them (the first `limit`, exactly as a loop that stops at the cap finds).
   * Throws {@link PatternTooExpensiveError} once this search's budget is spent.
   */
  async matchingLines(lines: string[], limit: number): Promise<number[]> {
    if (limit <= 0 || lines.length === 0) return [];
    if (this.spentMs >= this.budgetMs) throw new PatternTooExpensiveError(this.source, this.budgetMs);
    const w = await acquire();
    const hits: number[] = [];
    try {
      for (let from = 0; from < lines.length && hits.length < limit; ) {
        const to = batchEnd(lines, from);
        for (const i of await this.matchBatch(w, lines.slice(from, to), limit - hits.length)) hits.push(from + i);
        from = to;
      }
    } catch (err) {
      // Terminating is what stops a regex mid-backtrack; the pool replaces it.
      void w.terminate();
      throw err;
    }
    release(w);
    return hits;
  }

  /** One handoff to the worker, charged to this search's budget. */
  private async matchBatch(w: Worker, lines: string[], limit: number): Promise<number[]> {
    const remaining = this.budgetMs - this.spentMs;
    if (remaining <= 0) throw new PatternTooExpensiveError(this.source, this.budgetMs);
    const reply = await run(w, { source: this.source, flags: this.flags, lines, limit }, remaining + TRANSFER_GRACE_MS);
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

/** Where the batch starting at `from` ends: about {@link BATCH_CHARS} characters on, and never empty. */
function batchEnd(lines: string[], from: number): number {
  let to = from;
  let chars = 0;
  while (to < lines.length && (to === from || chars + lines[to]!.length <= BATCH_CHARS)) chars += lines[to++]!.length;
  return to;
}
