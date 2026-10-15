import { describe, expect, it } from 'vitest';
import {
  BATCH_CHARS,
  BoundedMatcher,
  MAX_PATTERN_LENGTH,
  MAX_WAITING,
  PATTERN_BUDGET_MS,
  PatternTooExpensiveError,
} from '../bounded-matcher.js';

/** The QA finding's pattern, and a 40-character line it backtracks on for ever. */
const CATASTROPHIC = '^(a+)+$';
const LONG_LINE = `${'a'.repeat(39)}!`;

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

describe('BoundedMatcher', () => {
  it('stops a catastrophic pattern over a 40-character line with the worded 400, and never stalls the loop', async () => {
    expect(LONG_LINE).toHaveLength(40);
    const started = Date.now();
    let caught: unknown;
    const stall = await longestStall(async () => {
      try {
        await new BoundedMatcher(CATASTROPHIC, '').matchingLines([LONG_LINE], 200);
      } catch (err) {
        caught = err;
      }
    });
    const took = Date.now() - started;
    expect(caught).toBeInstanceOf(PatternTooExpensiveError);
    expect((caught as PatternTooExpensiveError).status).toBe(400);
    expect((caught as Error).message).toMatch(/^Pattern too expensive: /);
    expect((caught as Error).message).toContain('simpler pattern');
    expect(PATTERN_BUDGET_MS).toBe(5_000);
    expect((caught as Error).message).toContain("this search's 5 s budget");
    expect(took).toBeLessThan(PATTERN_BUDGET_MS + 2_000);
    expect(stall).toBeLessThan(500);
  });

  it('answers ordinary patterns with exactly the lines RegExp#test matches', async () => {
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
      expect(await new BoundedMatcher(source, flags).matchingLines(lines, 1000), `/${source}/${flags}`).toEqual(expected);
    }
  });

  it('returns only the first `limit` matches', async () => {
    expect(await new BoundedMatcher('x', '').matchingLines(['x', 'y', 'x', 'x'], 2)).toEqual([0, 2]);
  });

  it('refuses invalid syntax with the 400 grep always gave', () => {
    expect(() => new BoundedMatcher('(', '')).toThrow(/^Invalid regex: /);
  });

  it('refuses a pattern too long to compile on the request thread, and accepts one at the limit', () => {
    expect(() => new BoundedMatcher('a'.repeat(MAX_PATTERN_LENGTH + 1), '')).toThrow(/^Pattern too long: /);
    expect(() => new BoundedMatcher('a'.repeat(MAX_PATTERN_LENGTH), '')).not.toThrow();
  });

  it('hands a large file over in batches and answers the same line numbers, up to `limit`', async () => {
    const filler = 'x'.repeat(999);
    const lines = Array.from({ length: Math.ceil((BATCH_CHARS * 2.5) / filler.length) }, (_, i) =>
      i % 700 === 0 ? `hit ${i}` : filler,
    );
    const expected = lines.flatMap((l, i) => (l.startsWith('hit') ? [i] : []));
    expect(expected.at(-1)! * filler.length).toBeGreaterThan(BATCH_CHARS * 2);
    expect(await new BoundedMatcher('^hit', '').matchingLines(lines, 10_000)).toEqual(expected);
    expect(await new BoundedMatcher('^hit', '').matchingLines(lines, 3)).toEqual(expected.slice(0, 3));
  });

  it('refuses a search with 503 once the queue for a worker is full, rather than holding its lines', async () => {
    // Every worker held by a pattern that runs out its budget, the queue filled behind them.
    const holding = Promise.allSettled(
      Array.from({ length: 4 }, () => new BoundedMatcher(CATASTROPHIC, '').matchingLines([LONG_LINE], 1)),
    );
    await new Promise((r) => setTimeout(r, 200));
    const queued = Array.from({ length: MAX_WAITING }, () => new BoundedMatcher('b', '').matchingLines(['b'], 1));
    await expect(new BoundedMatcher('b', '').matchingLines(['b'], 1)).rejects.toMatchObject({
      status: 503,
      details: { code: 'search_busy' },
    });
    // The queued searches are served once the workers come free.
    expect(await Promise.all(queued)).toEqual(queued.map(() => [0]));
    expect((await holding).every((r) => r.status === 'rejected')).toBe(true);
  });

  it('stops two expensive searches at once, and a matcher created meanwhile still answers', async () => {
    const results = await Promise.allSettled([
      new BoundedMatcher(CATASTROPHIC, '').matchingLines([LONG_LINE], 10),
      new BoundedMatcher('(a|aa)+$', '').matchingLines([`${'a'.repeat(60)}!`], 10),
      new BoundedMatcher('aaa', '').matchingLines(['xaaay'], 10),
    ]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: expect.any(PatternTooExpensiveError) });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.any(PatternTooExpensiveError) });
    expect(results[2]).toEqual({ status: 'fulfilled', value: [0] });
    // The terminated workers were replaced: the pool still serves.
    expect(await new BoundedMatcher('b', '').matchingLines(['a', 'b'], 10)).toEqual([1]);
  });
});
