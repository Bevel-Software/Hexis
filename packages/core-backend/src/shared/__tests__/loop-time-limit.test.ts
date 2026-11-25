import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoopTimeLimitError, withinLoopTime } from '../loop-time-limit.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Hold the event loop: nothing else in this process runs meanwhile. */
function holdTheLoop(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* busy */
  }
}

/** Work that needs the loop five times over, as a read that awaits a few things does. */
async function fiveTurns(): Promise<string> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return 'done';
}

describe('withinLoopTime', () => {
  it("answers the work's value, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const answer = withinLoopTime(Promise.resolve('value'), 1000);
    await expect(answer).resolves.toBe('value');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("throws what the work throws, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const boom = new Error('the read failed');
    await expect(withinLoopTime(Promise.reject(boom), 1000)).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up on work that never settles once the limit has passed, and not before', async () => {
    vi.useFakeTimers();
    let outcome: unknown = 'pending';
    withinLoopTime(new Promise<never>(() => {}), 1000, 250).catch((err: unknown) => {
      outcome = err;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(LoopTimeLimitError);
    expect((outcome as LoopTimeLimitError).message).toBe('not finished within its 1000ms limit');
    expect(vi.getTimerCount()).toBe(0);
  });

  // The reason this exists. The loop is held for five times the limit while
  // the work is under way. A clock limit has passed by the time the loop is
  // free, and its timer runs before the work's next turn. This limit spent one
  // tick on the whole wait.
  it('does not spend the limit on time the event loop was held', async () => {
    const answer = withinLoopTime(fiveTurns(), 200, 50);
    holdTheLoop(1000);
    await expect(answer).resolves.toBe('done');
  });

  it('spends a short limit in several ticks too, so a held loop cannot use it up either', async () => {
    const answer = withinLoopTime(fiveTurns(), 100);
    holdTheLoop(500);
    await expect(answer).resolves.toBe('done');
  });

  it('a clock limit of the same length gives up on the same work', async () => {
    const clockLimit = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('clock limit')), 200));
    const answer = Promise.race([fiveTurns(), clockLimit]);
    holdTheLoop(1000);
    await expect(answer).rejects.toThrow('clock limit');
  });

  it('a result that arrives after the limit is dropped without a second outcome', async () => {
    vi.useFakeTimers();
    let settle!: (v: string) => void;
    const late = new Promise<string>((r) => {
      settle = r;
    });
    const answer = withinLoopTime(late, 500, 250);
    const seen = answer.then(
      (v) => `resolved ${v}`,
      (e: unknown) => `rejected ${(e as Error).name}`,
    );
    await vi.advanceTimersByTimeAsync(500);
    settle('too late');
    await expect(seen).resolves.toBe('rejected LoopTimeLimitError');
  });
});
