/**
 * Short-lived memo of manual-registration FAILURES, keyed per (user, manual).
 *
 * Registering a `.tool` manual with a present-but-broken credential (an
 * expired OAuth session, a revoked key) fails with a live network round-trip —
 * and sessions are rebuilt constantly (every external MCP connection runs a
 * full discovery), so one stale credential otherwise re-dials its provider on
 * every build, forever. Besides the log noise, each failed attempt on the
 * MCP transport layer's long-lived shared session leaks an abort listener
 * upstream — the memo starves that loop.
 *
 * Failures are remembered for a few minutes only: a repaired credential is
 * picked up at the next build after expiry (or immediately after a restart).
 * Successes are never cached here — this is a circuit breaker, not a catalog
 * cache. Expired entries are pruned opportunistically so the map stays
 * bounded by the number of DISTINCT recently-failing (user, manual) pairs.
 */
export class ManualFailureMemo {
  private readonly failures = new Map<string, { message: string; expiresAt: number }>();
  /**
   * Advanced by every clear operation. A registration attempt captures the
   * generation BEFORE its (slow, awaited) network call and hands it back to
   * {@link recordFailure} — if a clear happened in between (the user just
   * repaired the credential), the stale in-flight failure is discarded instead
   * of resurrecting a memo entry the clear was meant to remove.
   */
  private generation = 0;

  constructor(
    private readonly ttlMs: number = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Capture before an awaited registration attempt; pass to {@link recordFailure}. */
  get currentGeneration(): number {
    return this.generation;
  }

  private key(userId: string, manualName: string): string {
    return `${userId} ${manualName}`;
  }

  /** The remembered failure message when (user, manual) failed recently; undefined otherwise. */
  recentFailure(userId: string, manualName: string): string | undefined {
    const now = this.now();
    for (const [k, entry] of this.failures) {
      if (entry.expiresAt <= now) this.failures.delete(k);
    }
    return this.failures.get(this.key(userId, manualName))?.message;
  }

  /**
   * Record a failure — unless `generation` (captured before the attempt) is
   * stale, meaning a clear ran while the attempt was in flight. Dropping the
   * record is the conservative direction: the worst case is one extra retry.
   */
  recordFailure(userId: string, manualName: string, message: string, generation?: number): void {
    if (generation !== undefined && generation !== this.generation) return;
    this.failures.set(this.key(userId, manualName), {
      message,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  /** Forget a pair (e.g. after a successful registration proves the credential works again). */
  clear(userId: string, manualName: string): void {
    this.generation += 1;
    this.failures.delete(this.key(userId, manualName));
  }

  /**
   * Forget every failure for one user — called when their secrets change, so a
   * just-repaired credential is retried on the VERY NEXT build instead of
   * waiting out the TTL.
   */
  clearUser(userId: string): void {
    this.generation += 1;
    const prefix = `${userId} `;
    for (const k of this.failures.keys()) {
      if (k.startsWith(prefix)) this.failures.delete(k);
    }
  }

  /** Forget everything — a SHARED secret changed, which can affect any user. */
  clearAll(): void {
    this.generation += 1;
    this.failures.clear();
  }
}
