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

describe('SurfaceLogThrottle — a wall clock that steps backwards', () => {
  const shape = { tools: 5, manuals: 2 };

  it('does not stall pruning until the clock climbs back past the last sweep', () => {
    let now = 1_000_000;
    const throttle = new SurfaceLogThrottle(60_000, () => now);

    throttle.decide('a', shape); // t0 — first sweep
    now += 60_000;
    throttle.decide('b', shape); // t0+60s — sweep (a dropped); last sweep is now t0+60s

    // The clock steps back 45s (NTP correction / VM restore). A cadence that
    // waited for `now - lastSweep >= interval` would not sweep again until
    // t0+120s in the OLD domain — 105s from here, not 60s.
    now -= 45_000; // t0+15s
    throttle.decide('c', shape);
    now += 60_000; // t0+75s — c has been quiet a full interval in the new domain
    throttle.decide('d', shape);

    // c is gone: the backwards step reset the cadence instead of stalling it.
    // So is b: its stamp (t0+60s) was in the future at the reset, so it was
    // restamped as seen then, and has now been quiet an interval too.
    expect(throttle.size()).toBe(1);
  });
});

describe('SurfaceLogThrottle — a user rebuilding under suppression is not quiet', () => {
  const shape = { tools: 5, manuals: 2 };

  it('survives another user\'s sweep, so the count its next line owes is not lost', () => {
    let now = 1_000_000;
    const throttle = new SurfaceLogThrottle(60_000, () => now);

    throttle.decide('a', shape); // t0: logged
    now += 30_000;
    throttle.decide('a', shape); // t0+30s: suppressed (1) — a is active
    now += 30_000;
    // t0+60s: another user's request runs the sweep. a's last LOGGED line is
    // an interval old, but a rebuilt thirty seconds ago; it stays.
    throttle.decide('b', shape);
    expect(throttle.size()).toBe(2);
    // a's next line carries the rebuild that was suppressed, not zero.
    expect(throttle.decide('a', shape)).toEqual({ log: true, suppressed: 1 });
  });

  it('is still forgotten once it has not rebuilt at all for an interval', () => {
    let now = 1_000_000;
    const throttle = new SurfaceLogThrottle(60_000, () => now);
    throttle.decide('a', shape);
    now += 30_000;
    throttle.decide('a', shape); // suppressed
    now += 60_000; // a has been quiet a whole interval since that rebuild
    throttle.decide('b', shape); // sweep
    expect(throttle.size()).toBe(1);
  });
});

describe('SurfaceLogThrottle — a large clock rollback', () => {
  const shape = { tools: 5, manuals: 2 };

  it('does not keep pre-rollback users for the length of the step — they age from the reset', () => {
    let now = 1_000_000;
    const throttle = new SurfaceLogThrottle(60_000, () => now);

    throttle.decide('a', shape); // t0
    now += 60_000;
    throttle.decide('b', shape); // t0+60s — sweep; b stamped t0+60s

    // The clock rolls back ten intervals. b's stamp is now 10 minutes in the
    // future; waiting for the clock to pass it by an interval would keep b
    // for eleven intervals — far past the two-interval bound.
    now -= 600_000; // t0-540s
    throttle.decide('c', shape); // sweep (cadence reset): b restamped as seen now
    now += 60_000; // one interval in the new domain
    throttle.decide('d', shape); // sweep: b and c have been quiet an interval — gone

    expect(throttle.size()).toBe(1);
  });
});
