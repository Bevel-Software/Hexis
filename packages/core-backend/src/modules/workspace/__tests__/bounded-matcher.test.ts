import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerPatternMatcher, type WorkerPatternMatcherOptions } from '../bounded-matcher.js';
import { PatternTooExpensiveError } from '../pattern-matcher.contract.js';

/** The QA finding's pattern, and a 40-character line it backtracks on for ever. */
const CATASTROPHIC = '^(a+)+$';
const LONG_LINE = `${'a'.repeat(39)}!`;
/** The ticket's per-search budget (Razvan, 2026-10-15). */
const FIVE_SECONDS = 5_000;

let matchers: WorkerPatternMatcher[] = [];
/** A matcher of the test's own, closed after it — the defaults unless a test says otherwise. */
function matcher(opts?: WorkerPatternMatcherOptions): WorkerPatternMatcher {
  const m = new WorkerPatternMatcher(opts);
  matchers.push(m);
  return m;
}
afterEach(async () => {
  await Promise.all(matchers.map((m) => m.close()));
  matchers = [];
});

/**
 * The longest the event loop went without running a timer while `work` ran.
 * A pattern run on the loop would show the whole match time here.
 */
async function longestStall(work: () => Promise<unknown>): Promise<number> {
  let last = Date.now();
  let worst = 0;
  const tick = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 10);
  try {
    await work().catch(() => {});
  } finally {
    clearInterval(tick);
  }
  return Math.max(worst, Date.now() - last);
}

describe('WorkerPatternMatcher', () => {
  it('stops a catastrophic pattern over a 40-character line with the worded 400 in its 5 s budget, and never stalls the loop', async () => {
    expect(LONG_LINE).toHaveLength(40);
    const started = Date.now();
    let caught: unknown;
    const stall = await longestStall(async () => {
      try {
        await matcher().search(CATASTROPHIC, '').matchingLines([LONG_LINE], 200);
      } catch (err) {
        caught = err;
      }
    });
    const took = Date.now() - started;
    expect(caught).toBeInstanceOf(PatternTooExpensiveError);
    expect((caught as PatternTooExpensiveError).status).toBe(400);
    expect((caught as Error).message).toMatch(/^Pattern too expensive: /);
    expect((caught as Error).message).toContain('simpler pattern');
    expect((caught as Error).message).toContain("this search's 5 s budget");
    expect(took).toBeGreaterThanOrEqual(FIVE_SECONDS - 100);
    expect(took).toBeLessThan(FIVE_SECONDS + 2_000);
    expect(stall).toBeLessThan(500);
  });

  it('answers ordinary patterns with exactly the lines RegExp#test matches', async () => {
    const m = matcher();
    const lines = ['hello world', 'Getting started', 'aaa', 'line 42', '', 'foo|bar', 'bar baz', LONG_LINE];
    for (const [source, flags] of [
      ['world', ''],
      ['^aaa$', ''],
      ['getting started', 'i'],
      ['[0-9]+', ''],
      ['foo|baz', ''],
      ['^$', ''],
      ['a+!$', ''],
    ] as const) {
      const re = new RegExp(source, flags);
      const expected = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
      expect(await m.search(source, flags).matchingLines(lines, 1000), `/${source}/${flags}`).toEqual(expected);
    }
  });

  it('returns only the first `limit` matches', async () => {
    expect(await matcher().search('x', '').matchingLines(['x', 'y', 'x', 'x'], 2)).toEqual([0, 2]);
  });

  it('refuses a sizing that could never serve a search when it is built, not when a search hangs on it', () => {
    expect(() => new WorkerPatternMatcher({ poolMax: 0 })).toThrow(/poolMax must be an integer from 1 /);
    // Past the longest delay setTimeout honours, the timer would fire after 1 ms and stop every search.
    expect(() => new WorkerPatternMatcher({ budgetMs: 2_147_483_647 })).toThrow(/budgetMs must be an integer from 1 to 2147483397/);
    expect(() => new WorkerPatternMatcher({ poolMax: 1.5 })).toThrow(RangeError);
    expect(() => new WorkerPatternMatcher({ budgetMs: 0 })).toThrow(/budgetMs/);
    expect(() => new WorkerPatternMatcher({ maxWaiting: -1 })).toThrow(/maxWaiting/);
    expect(() => new WorkerPatternMatcher({ batchChars: Number.NaN })).toThrow(/batchChars/);
    expect(() => matcher({ maxWaiting: 0 })).not.toThrow();
  });

  it('serves an ordinary search under the largest budget the timer can hold', async () => {
    expect(await matcher({ budgetMs: 2_147_483_647 - 250 }).search('b', '').matchingLines(['a', 'b'], 10)).toEqual([1]);
  });

  it('refuses invalid syntax with the 400 grep always gave', () => {
    expect(() => matcher().search('(', '')).toThrow(/^Invalid regex: /);
  });

  it('refuses a pattern too long to compile on the request thread, and accepts one at the limit', () => {
    const m = matcher({ maxPatternLength: 10 });
    expect(() => m.search('a'.repeat(11), '')).toThrow(/^Pattern too long: /);
    expect(() => m.search('a'.repeat(10), '')).not.toThrow();
  });

  it('hands a large file over in batches and answers the same line numbers, up to `limit`', async () => {
    const m = matcher({ batchChars: 100 });
    const filler = 'x'.repeat(9);
    const lines = Array.from({ length: 250 }, (_, i) => (i % 7 === 0 ? `hit ${i}` : filler));
    const expected = lines.flatMap((l, i) => (l.startsWith('hit') ? [i] : []));
    expect(expected.at(-1)! * filler.length).toBeGreaterThan(200);
    expect(await m.search('^hit', '').matchingLines(lines, 10_000)).toEqual(expected);
    expect(await m.search('^hit', '').matchingLines(lines, 3)).toEqual(expected.slice(0, 3));
  });

  it('hands a line longer than one batch over in shared memory, never in a message, and matches it exactly', async () => {
    const m = matcher({ batchChars: 100 });
    // A lone surrogate included: the line must reach the worker code unit for code unit.
    const long = `${'x'.repeat(1_000)}\uD800 tail ${'y'.repeat(500)}`;
    const lines = ['short', long, 'z'.repeat(400), 'end tail'];
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    try {
      for (const pattern of ['tail', '\\uD800 tail', '^x+\\uD800', 'y{500}$', '^z+$', 'nowhere']) {
        const re = new RegExp(pattern);
        const expected = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
        expect(await m.search(pattern, '').matchingLines(lines, 10_000)).toEqual(expected);
      }
      const postedChars = posted.mock.calls.map(([msg]) =>
        ((msg as { lines?: string[] }).lines ?? []).reduce((n, l) => n + l.length, 0),
      );
      expect(postedChars.length).toBeGreaterThan(0);
      expect(Math.max(...postedChars)).toBeLessThanOrEqual(100);
    } finally {
      posted.mockRestore();
    }
  });

  it('refuses a search with 503 once the queue for a worker is full, rather than holding its lines', async () => {
    const m = matcher({ budgetMs: 500, poolMax: 2, maxWaiting: 2 });
    // Every worker held by a pattern that runs out its budget, the queue filled behind them.
    const holding = Promise.allSettled(Array.from({ length: 2 }, () => m.search(CATASTROPHIC, '').matchingLines([LONG_LINE], 1)));
    await new Promise((r) => setTimeout(r, 100));
    const queued = Array.from({ length: 2 }, () => m.search('b', '').matchingLines(['b'], 1));
    await expect(m.search('b', '').matchingLines(['b'], 1)).rejects.toMatchObject({
      status: 503,
      details: { code: 'search_busy' },
    });
    // The queued searches are served once the workers come free.
    expect(await Promise.all(queued)).toEqual(queued.map(() => [0]));
    expect((await holding).every((r) => r.status === 'rejected')).toBe(true);
  });

  it('stops two expensive searches at once, and a search started meanwhile still answers', async () => {
    const m = matcher({ budgetMs: 500 });
    const results = await Promise.allSettled([
      m.search(CATASTROPHIC, '').matchingLines([LONG_LINE], 10),
      m.search('(a|aa)+$', '').matchingLines([`${'a'.repeat(60)}!`], 10),
      m.search('aaa', '').matchingLines(['xaaay'], 10),
    ]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: expect.any(PatternTooExpensiveError) });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.any(PatternTooExpensiveError) });
    expect(results[2]).toEqual({ status: 'fulfilled', value: [0] });
    // The terminated workers were replaced: the pool still serves.
    expect(await m.search('b', '').matchingLines(['a', 'b'], 10)).toEqual([1]);
  });

  it('ends its workers on close: a search running then, and one after, is answered busy', async () => {
    const m = matcher();
    const running = m.search(CATASTROPHIC, '').matchingLines([LONG_LINE], 1);
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    await m.close();
    await expect(running).rejects.toMatchObject({ status: 503, details: { code: 'search_busy' } });
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(m.search('b', '').matchingLines(['b'], 1)).rejects.toMatchObject({ status: 503 });
  });

  it('answers busy at once when closed while a long line is still being written to shared memory', async () => {
    // A line of a million characters written ten at a time: many turns of the loop to close in.
    const m = matcher({ budgetMs: 3_000, batchChars: 10 });
    const running = m.search('nowhere', '').matchingLines(['a'.repeat(1_000_000)], 1);
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    await m.close();
    await expect(running).rejects.toMatchObject({ status: 503, details: { code: 'search_busy' } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
