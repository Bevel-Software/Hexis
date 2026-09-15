import { describe, expect, it } from 'vitest';
import { DEFAULT_SURFACE_LOG_INTERVAL_MS, SurfaceLogThrottle } from '../surface-log-throttle.js';

/**
 * The surface line must keep appearing (it is the measurement of the
 * stateless design's per-request cost) without appearing per request. What
 * is pinned: first rebuild logs; identical rebuilds inside the interval do
 * not and are counted; a shape change logs at once; the interval elapsing
 * logs again carrying the count; users are independent; quiet users are
 * forgotten.
 */
describe('SurfaceLogThrottle', () => {
  function make(intervalMs = DEFAULT_SURFACE_LOG_INTERVAL_MS) {
    let now = 1_000_000;
    const throttle = new SurfaceLogThrottle(intervalMs, () => now);
    return { throttle, advance: (ms: number) => (now += ms) };
  }

  it('logs the first rebuild for a user, then suppresses identical rebuilds inside the interval', () => {
    const { throttle } = make();
    expect(throttle.decide('u1', { tools: 5, manuals: 2 })).toEqual({ log: true, suppressed: 0 });
    expect(throttle.decide('u1', { tools: 5, manuals: 2 })).toEqual({ log: false, suppressed: 1 });
    expect(throttle.decide('u1', { tools: 5, manuals: 2 })).toEqual({ log: false, suppressed: 2 });
  });

  it('logs at once when the shape changes, with the count of what it suppressed', () => {
    const { throttle } = make();
    throttle.decide('u1', { tools: 5, manuals: 2 });
    throttle.decide('u1', { tools: 5, manuals: 2 });
    // A manual failed (or was fixed): the count moved.
    expect(throttle.decide('u1', { tools: 3, manuals: 2 })).toEqual({ log: true, suppressed: 1 });
    // The new shape is now the baseline.
    expect(throttle.decide('u1', { tools: 3, manuals: 2 })).toEqual({ log: false, suppressed: 1 });
  });

  it('logs again once the interval has elapsed, carrying the suppressed count', () => {
    const { throttle, advance } = make(60_000);
    throttle.decide('u1', { tools: 5, manuals: 2 });
    throttle.decide('u1', { tools: 5, manuals: 2 });
    throttle.decide('u1', { tools: 5, manuals: 2 });
    advance(59_999);
    expect(throttle.decide('u1', { tools: 5, manuals: 2 }).log).toBe(false);
    advance(1);
    expect(throttle.decide('u1', { tools: 5, manuals: 2 })).toEqual({ log: true, suppressed: 3 });
  });

  it('keeps users independent', () => {
    const { throttle } = make();
    expect(throttle.decide('u1', { tools: 5, manuals: 2 }).log).toBe(true);
    expect(throttle.decide('u2', { tools: 5, manuals: 2 }).log).toBe(true);
    expect(throttle.decide('u1', { tools: 5, manuals: 2 }).log).toBe(false);
    expect(throttle.decide('u2', { tools: 5, manuals: 2 }).log).toBe(false);
  });

  it('forgets a user who has been quiet for the interval — the next rebuild logs fresh', () => {
    const { throttle, advance } = make(60_000);
    throttle.decide('u1', { tools: 5, manuals: 2 });
    throttle.decide('u1', { tools: 5, manuals: 2 });
    advance(60_000);
    // Another user's rebuild is what runs the prune; u1's stale entry goes.
    throttle.decide('u2', { tools: 1, manuals: 1 });
    expect(throttle.decide('u1', { tools: 5, manuals: 2 })).toEqual({ log: true, suppressed: 0 });
  });
});

describe('SurfaceLogThrottle — pruning cost', () => {
  const shape = { tools: 5, manuals: 2 };

  it('sweeps once per interval, not on every rebuild — and every quiet user is still gone by the next sweep', () => {
    let now = 1_000_000;
    const throttle = new SurfaceLogThrottle(60_000, () => now);

    throttle.decide('a', shape); // t0 — the first sweep runs here (nothing to drop)
    now += 30_000;
    throttle.decide('b', shape); // t0+30s — no sweep owed yet
    now += 30_000;
    throttle.decide('c', shape); // t0+60s — sweep: a (quiet 60s) dropped, b kept
    expect(throttle.size()).toBe(2);

    now += 30_001;
    throttle.decide('d', shape); // t0+90.001s — b is quiet ≥ interval, but the
    // sweep ran 30s ago, so no walk happens on this request: b waits.
    expect(throttle.size()).toBe(3);

    now += 29_999;
    throttle.decide('e', shape); // t0+120s — sweep: b and c dropped, d kept
    expect(throttle.size()).toBe(2);
  });
});
