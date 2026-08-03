import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../rate-limit.js';

describe('FixedWindowRateLimiter', () => {
  it('allows up to max attempts per window, then refuses', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(3, 1000, () => now);
    expect(limiter.consume('k')).toBe(true);
    expect(limiter.consume('k')).toBe(true);
    expect(limiter.consume('k')).toBe(true);
    expect(limiter.consume('k')).toBe(false);
    // A different key has its own budget.
    expect(limiter.consume('other')).toBe(true);
    // Window rollover restores the budget.
    now = 1001;
    expect(limiter.consume('k')).toBe(true);
  });

  it('reset() clears a key immediately', () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000, () => 0);
    expect(limiter.consume('k')).toBe(true);
    expect(limiter.consume('k')).toBe(false);
    limiter.reset('k');
    expect(limiter.consume('k')).toBe(true);
  });

  it('prunes expired windows so the map stays bounded', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(1, 1000, () => now);
    for (let i = 0; i < 100; i++) limiter.consume(`k${i}`);
    now = 2000;
    limiter.consume('fresh');
    // Internal map pruned to just the fresh key.
    expect((limiter as unknown as { hits: Map<string, unknown> }).hits.size).toBe(1);
  });
});
