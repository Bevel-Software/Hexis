import { describe, expect, it } from 'vitest';
import { ManualFailureMemo } from '../manual-failure-memo.js';

type Internals = { pairClears: Map<string, unknown>; userClears: Map<string, unknown>; inFlight: Map<number, number> };
const internals = (memo: ManualFailureMemo) => memo as unknown as Internals;

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
    // A registration attempt begins, then awaits its (slow) network call…
    const generation = memo.beginAttempt();
    // …meanwhile the user repairs their credential (secrets change → clear).
    memo.clearUser('u1');
    // The stale attempt completes with a failure from the OLD credential —
    // recording against the captured generation is a no-op.
    memo.recordFailure('u1', 'notion', 'invalid_token (stale)', generation);
    memo.endAttempt(generation);
    expect(memo.recentFailure('u1', 'notion')).toBeUndefined();
    // A FRESH attempt records normally.
    const fresh = memo.beginAttempt();
    memo.recordFailure('u1', 'notion', 'still broken', fresh);
    memo.endAttempt(fresh);
    expect(memo.recentFailure('u1', 'notion')).toBe('still broken');
  });

  it("a concurrent success of ANOTHER manual does not discard this manual's failure", () => {
    const memo = new ManualFailureMemo(60_000, () => 0);
    const generation = memo.beginAttempt();
    // Manuals register concurrently: granola succeeds while notion is in flight…
    memo.clear('u1', 'granola');
    // …and another user's secrets change.
    memo.clearUser('u2');
    // notion's failure is still current — nothing covering (u1, notion) was cleared.
    memo.recordFailure('u1', 'notion', 'invalid_token', generation);
    memo.endAttempt(generation);
    expect(memo.recentFailure('u1', 'notion')).toBe('invalid_token');
  });

  it('a concurrent success of the SAME pair still discards the out-of-order failure', () => {
    const memo = new ManualFailureMemo(60_000, () => 0);
    const generation = memo.beginAttempt();
    memo.clear('u1', 'notion');
    memo.recordFailure('u1', 'notion', 'transient', generation);
    memo.endAttempt(generation);
    expect(memo.recentFailure('u1', 'notion')).toBeUndefined();
  });

  it('clearAll() discards every in-flight failure', () => {
    const memo = new ManualFailureMemo(60_000, () => 0);
    const generation = memo.beginAttempt();
    memo.clearAll();
    memo.recordFailure('u1', 'notion', 'x', generation);
    memo.recordFailure('u2', 'granola', 'y', generation);
    memo.endAttempt(generation);
    expect(memo.recentFailure('u1', 'notion')).toBeUndefined();
    expect(memo.recentFailure('u2', 'granola')).toBeUndefined();
  });

  it('an attempt that outlives the TTL still records its failure when only unrelated clears happened', () => {
    let now = 0;
    const memo = new ManualFailureMemo(1000, () => now);
    const slow = memo.beginAttempt();
    memo.clear('u2', 'granola'); // unrelated
    now = 10_000; // far past the TTL, with lookups running meanwhile
    memo.recentFailure('u9', 'anything');
    memo.recordFailure('u1', 'notion', 'invalid_token', slow);
    memo.endAttempt(slow);
    expect(memo.recentFailure('u1', 'notion')).toBe('invalid_token');
  });

  it('keeps a clear record exactly while an attempt that predates it is in flight', () => {
    let now = 0;
    const memo = new ManualFailureMemo(1000, () => now);
    const slow = memo.beginAttempt();
    for (let i = 0; i < 50; i++) memo.clear(`u${i}`, 'notion');
    memo.clearUser('u0');
    now = 10_000; // time alone never drops a record an attempt still needs
    memo.recentFailure('u0', 'notion');
    expect(internals(memo).pairClears.size).toBe(50);
    // …so the slow attempt covered by a clear stays discarded.
    memo.recordFailure('u7', 'notion', 'from before the clear', slow);
    expect(memo.recentFailure('u7', 'notion')).toBeUndefined();

    memo.endAttempt(slow);
    expect(internals(memo).pairClears.size).toBe(0);
    expect(internals(memo).userClears.size).toBe(0);
    expect(internals(memo).inFlight.size).toBe(0);
  });

  it('with no attempt in flight, a clear leaves no record behind', () => {
    const memo = new ManualFailureMemo(60_000, () => 0);
    memo.clear('u1', 'notion');
    memo.clearUser('u2');
    expect(internals(memo).pairClears.size).toBe(0);
    expect(internals(memo).userClears.size).toBe(0);
  });

  it('endAttempt is balanced per attempt: overlapping attempts at one generation each count', () => {
    const memo = new ManualFailureMemo(60_000, () => 0);
    const a = memo.beginAttempt();
    const b = memo.beginAttempt();
    expect(a).toBe(b);
    memo.clear('u1', 'notion');
    memo.endAttempt(a);
    // b is still in flight and predates the clear: the record must survive.
    memo.recordFailure('u1', 'notion', 'stale', b);
    expect(memo.recentFailure('u1', 'notion')).toBeUndefined();
    memo.endAttempt(b);
    memo.endAttempt(b); // extra end is a no-op
    expect(internals(memo).pairClears.size).toBe(0);
  });

  it('prunes expired failures so the map stays bounded', () => {
    let now = 0;
    const memo = new ManualFailureMemo(1000, () => now);
    for (let i = 0; i < 50; i++) memo.recordFailure(`u${i}`, 'notion', 'x');
    now = 2000;
    memo.recentFailure('u0', 'notion');
    expect((memo as unknown as { failures: Map<string, unknown> }).failures.size).toBe(0);
  });
});
