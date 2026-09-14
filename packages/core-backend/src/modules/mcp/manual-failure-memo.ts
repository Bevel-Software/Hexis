/**
 * Short-lived memo of manual-registration FAILURES, keyed per (user, manual).
 *
 * Registering a `.tool` manual with a present-but-broken credential (an
 * expired OAuth session, a revoked key) fails with a live network round-trip —
 * and the tool surface is rebuilt on every MCP request, so one stale credential
 * otherwise re-dials its provider on every request, forever.
 *
 * The "manual" key is whatever the caller passes; the MCP service passes the
 * manual's name plus a fingerprint of its definition, so editing a manual that
 * just failed (a corrected URL in `mcp.json`) is retried on the next request
 * instead of waiting out the TTL.
 *
 * Failures are remembered for a few minutes only: a repaired credential is
 * picked up at the next build after expiry (or immediately after a restart).
 * Successes are never cached here — this is a circuit breaker, not a catalog
 * cache. Expired entries are pruned opportunistically so the maps stay
 * bounded by the number of DISTINCT recently-failing or recently-cleared
 * (user, manual) pairs.
 */
export class ManualFailureMemo {
  private readonly failures = new Map<string, { message: string; expiresAt: number }>();

  /**
   * Out-of-order protection. Every clear takes the next value of a monotonic
   * counter and remembers it for the scope it cleared: one pair, one user, or
   * everyone. A registration attempt captures the counter BEFORE its (slow,
   * awaited) network call and hands it back to {@link recordFailure}; a failure
   * is discarded only when a clear covering THAT pair ran in between. A success
   * of an unrelated manual running concurrently therefore never discards it.
   */
  private counter = 0;
  private allClearedAt = 0;
  private readonly userClears = new Map<string, { generation: number; expiresAt: number }>();
  private readonly pairClears = new Map<string, { generation: number; expiresAt: number }>();
  /**
   * The highest generation among pruned clear records. An attempt captured
   * before it may have been covered by a record that no longer exists, so its
   * failure is discarded — the conservative direction (one extra retry) for an
   * attempt that outlived the TTL.
   */
  private prunedFloor = 0;

  constructor(
    private readonly ttlMs: number = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Capture before an awaited registration attempt; pass to {@link recordFailure}. */
  get currentGeneration(): number {
    return this.counter;
  }

  private key(userId: string, manualName: string): string {
    return `${userId} ${manualName}`;
  }

  /** The remembered failure message when (user, manual) failed recently; undefined otherwise. */
  recentFailure(userId: string, manualName: string): string | undefined {
    this.prune();
    return this.failures.get(this.key(userId, manualName))?.message;
  }

  /**
   * Record a failure — unless `generation` (captured before the attempt) is
   * stale for this pair, meaning a clear covering it ran while the attempt was
   * in flight. Dropping the record is the conservative direction: the worst
   * case is one extra retry.
   */
  recordFailure(userId: string, manualName: string, message: string, generation?: number): void {
    if (generation !== undefined && this.clearedSince(userId, manualName, generation)) return;
    this.failures.set(this.key(userId, manualName), {
      message,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  /** Forget a pair (e.g. after a successful registration proves the credential works again). */
  clear(userId: string, manualName: string): void {
    const key = this.key(userId, manualName);
    this.pairClears.set(key, this.clearRecord());
    this.failures.delete(key);
  }

  /**
   * Forget every failure for one user — called when their secrets change, so a
   * just-repaired credential is retried on the VERY NEXT build instead of
   * waiting out the TTL.
   */
  clearUser(userId: string): void {
    this.userClears.set(userId, this.clearRecord());
    const prefix = `${userId} `;
    for (const k of this.failures.keys()) {
      if (k.startsWith(prefix)) this.failures.delete(k);
    }
  }

  /** Forget everything — a SHARED secret changed, which can affect any user. */
  clearAll(): void {
    this.allClearedAt = this.clearRecord().generation;
    this.failures.clear();
  }

  private clearRecord(): { generation: number; expiresAt: number } {
    this.counter += 1;
    return { generation: this.counter, expiresAt: this.now() + this.ttlMs };
  }

  private clearedSince(userId: string, manualName: string, generation: number): boolean {
    return (
      generation < this.prunedFloor ||
      this.allClearedAt > generation ||
      (this.userClears.get(userId)?.generation ?? 0) > generation ||
      (this.pairClears.get(this.key(userId, manualName))?.generation ?? 0) > generation
    );
  }

  private prune(): void {
    const now = this.now();
    for (const [k, entry] of this.failures) {
      if (entry.expiresAt <= now) this.failures.delete(k);
    }
    for (const clears of [this.userClears, this.pairClears]) {
      for (const [k, record] of clears) {
        if (record.expiresAt > now) continue;
        clears.delete(k);
        this.prunedFloor = Math.max(this.prunedFloor, record.generation);
      }
    }
  }
}
