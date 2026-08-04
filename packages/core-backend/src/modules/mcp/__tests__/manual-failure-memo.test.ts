import { describe, expect, it } from 'vitest';
import { ManualFailureMemo } from '../manual-failure-memo.js';

describe('ManualFailureMemo', () => {
  it('remembers a failure per (user, manual) until the TTL expires', () => {
    let now = 0;
    const memo = new ManualFailureMemo(1000, () => now);
    memo.recordFailure('u1', 'notion', 'invalid_token');
    expect(memo.recentFailure('u1', 'notion')).toBe('invalid_token');
    // Scoped: a DIFFERENT user's notion (their own credential) is unaffected.
    expect(memo.recentFailure('u2', 'notion')).toBeUndefined();
    // Same user, different manual — unaffected.
    expect(memo.recentFailure('u1', 'granola')).toBeUndefined();
    // Expiry restores retries (a repaired credential gets picked up).
    now = 1001;
    expect(memo.recentFailure('u1', 'notion')).toBeUndefined();
  });

  it('clear() forgets immediately (successful registration path)', () => {
    const memo = new ManualFailureMemo(60_000, () => 0);
    memo.recordFailure('u1', 'notion', 'invalid_token');
    memo.clear('u1', 'notion');
    expect(memo.recentFailure('u1', 'notion')).toBeUndefined();
  });

  it('prunes expired entries so the map stays bounded', () => {
    let now = 0;
    const memo = new ManualFailureMemo(1000, () => now);
    for (let i = 0; i < 50; i++) memo.recordFailure(`u${i}`, 'notion', 'x');
    now = 2000;
    memo.recentFailure('u0', 'notion');
    expect((memo as unknown as { failures: Map<string, unknown> }).failures.size).toBe(0);
  });
});
