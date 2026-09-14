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

  it('clearUser() forgets ONLY that user (a secrets change retries immediately)', () => {
    const memo = new ManualFailureMemo(60_000, () => 0);
    memo.recordFailure('u1', 'notion', 'invalid_token');
    memo.recordFailure('u1', 'granola', 'expired');
    memo.recordFailure('u2', 'notion', 'invalid_token');
    memo.clearUser('u1');
    expect(memo.recentFailure('u1', 'notion')).toBeUndefined();
    expect(memo.recentFailure('u1', 'granola')).toBeUndefined();
    expect(memo.recentFailure('u2', 'notion')).toBe('invalid_token');
  });

  it('clearAll() forgets everything (a shared secret changed)', () => {
    const memo = new ManualFailureMemo(60_000, () => 0);
    memo.recordFailure('u1', 'notion', 'x');
    memo.recordFailure('u2', 'granola', 'y');
    memo.clearAll();
    expect(memo.recentFailure('u1', 'notion')).toBeUndefined();
    expect(memo.recentFailure('u2', 'granola')).toBeUndefined();
  });

  it('an out-of-order completion after a clear cannot resurrect the failure', () => {
    const memo = new ManualFailureMemo(60_000, () => 0);
    // A registration attempt captures the generation, then awaits its (slow)
    // network call…
    const generation = memo.currentGeneration;
    // …meanwhile the user repairs their credential (secrets change → clear).
    memo.clearUser('u1');
    // The stale attempt completes with a failure from the OLD credential —
    // recording against the captured generation is a no-op.
    memo.recordFailure('u1', 'notion', 'invalid_token (stale)', generation);
    expect(memo.recentFailure('u1', 'notion')).toBeUndefined();
    // A FRESH attempt (current generation) records normally.
    memo.recordFailure('u1', 'notion', 'still broken', memo.currentGeneration);
    expect(memo.recentFailure('u1', 'notion')).toBe('still broken');
  });

  it("a concurrent success of ANOTHER manual does not discard this manual's failure", () => {
    const memo = new ManualFailureMemo(60_000, () => 0);
    const generation = memo.currentGeneration;
    // Manuals register concurrently: granola succeeds while notion is in flight…
    memo.clear('u1', 'granola');
    // …and another user's secrets change.
    memo.clearUser('u2');
    // notion's failure is still current — nothing covering (u1, notion) was cleared.
    memo.recordFailure('u1', 'notion', 'invalid_token', generation);
    expect(memo.recentFailure('u1', 'notion')).toBe('invalid_token');
  });

  it('a concurrent success of the SAME pair still discards the out-of-order failure', () => {
    const memo = new ManualFailureMemo(60_000, () => 0);
    const generation = memo.currentGeneration;
    memo.clear('u1', 'notion');
    memo.recordFailure('u1', 'notion', 'transient', generation);
    expect(memo.recentFailure('u1', 'notion')).toBeUndefined();
  });

  it('clearAll() discards every in-flight failure', () => {
    const memo = new ManualFailureMemo(60_000, () => 0);
    const generation = memo.currentGeneration;
    memo.clearAll();
    memo.recordFailure('u1', 'notion', 'x', generation);
    memo.recordFailure('u2', 'granola', 'y', generation);
    expect(memo.recentFailure('u1', 'notion')).toBeUndefined();
    expect(memo.recentFailure('u2', 'granola')).toBeUndefined();
  });

  it('prunes clear records with their TTL, still discarding an attempt that predates a pruned clear', () => {
    let now = 0;
    const memo = new ManualFailureMemo(1000, () => now);
    const ancient = memo.currentGeneration;
    for (let i = 0; i < 50; i++) memo.clear(`u${i}`, 'notion');
    memo.clearUser('u0');
    now = 2000;
    memo.recentFailure('u0', 'notion'); // prunes
    const internals = memo as unknown as { pairClears: Map<string, unknown>; userClears: Map<string, unknown> };
    expect(internals.pairClears.size).toBe(0);
    expect(internals.userClears.size).toBe(0);
    // The record that would have covered it is gone; the conservative answer is still "stale".
    memo.recordFailure('u7', 'notion', 'from before the clear', ancient);
    expect(memo.recentFailure('u7', 'notion')).toBeUndefined();
    // An attempt started after the prune records normally.
    memo.recordFailure('u7', 'notion', 'current', memo.currentGeneration);
    expect(memo.recentFailure('u7', 'notion')).toBe('current');
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
