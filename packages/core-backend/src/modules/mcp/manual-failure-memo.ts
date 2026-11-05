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
 * cache. Expired failures are pruned opportunistically so the map stays
 * bounded by the number of DISTINCT recently-failing (user, manual) pairs.
 */
export class ManualFailureMemo {
  private readonly failures = new Map<string, { message: string; expiresAt: number }>();

  /**
   * Out-of-order protection. Every clear takes the next value of a monotonic
   * counter and remembers it for the scope it cleared: one pair, one user, or
   * everyone. A registration attempt starts with {@link beginAttempt}, which
   * captures the counter BEFORE its (slow, awaited) network call; its failure is
   * discarded only when a clear covering THAT pair ran in between. A success of
   * an unrelated manual, or a clear for another user, never discards it — no
   * matter how long the attempt takes.
   */
  private counter = 0;
  private allClearedAt = 0;
  private readonly userClears = new Map<string, number>();
  private readonly pairClears = new Map<string, number>();
  /**
   * Generations captured by attempts still in flight (generation → count). A
   * clear record matters only to an attempt that started before it, so a record
   * is kept exactly while such an attempt is running — which bounds the clear
   * maps by what concurrent attempts can still observe.
   */
  private readonly inFlight = new Map<number, number>();

  constructor(
    private readonly ttlMs: number = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Start a registration attempt. Pass the returned generation to
   * {@link recordFailure}, and ALWAYS to {@link endAttempt} when the attempt is
   * over (try/finally) — an attempt never ended keeps later clear records alive.
   */
  beginAttempt(): number {
    const generation = this.counter;
    this.inFlight.set(generation, (this.inFlight.get(generation) ?? 0) + 1);
    return generation;
  }

  /** The attempt started at `generation` is over (after any `recordFailure`/`clear` it made). */
  endAttempt(generation: number): void {
    const count = this.inFlight.get(generation);
    if (count === undefined) return;
    if (count <= 1) this.inFlight.delete(generation);
    else this.inFlight.set(generation, count - 1);
    this.pruneClears();
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
   * Record a failure — unless `generation` (from {@link beginAttempt}) is stale
   * for this pair, meaning a clear covering it ran while the attempt was in
   * flight. Dropping the record is the conservative direction: the worst case
   * is one extra retry.
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
    this.pairClears.set(key, this.nextGeneration());
    this.failures.delete(key);
    this.pruneClears();
  }

  /**
   * Forget every failure for one user — called when their secrets change, so a
   * just-repaired credential is retried on the VERY NEXT build instead of
   * waiting out the TTL.
   */
  clearUser(userId: string): void {
    this.userClears.set(userId, this.nextGeneration());
    const prefix = `${userId} `;
    for (const k of this.failures.keys()) {
      if (k.startsWith(prefix)) this.failures.delete(k);
    }
    this.pruneClears();
  }

  /** Forget everything — a SHARED secret changed, which can affect any user. */
  clearAll(): void {
    this.allClearedAt = this.nextGeneration();
    this.failures.clear();
  }

  private nextGeneration(): number {
    this.counter += 1;
    return this.counter;
  }

  private clearedSince(userId: string, manualName: string, generation: number): boolean {
    return (
      this.allClearedAt > generation ||
      (this.userClears.get(userId) ?? 0) > generation ||
      (this.pairClears.get(this.key(userId, manualName)) ?? 0) > generation
    );
  }

  /** Drop clear records no in-flight attempt predates: none of them can ever be consulted again. */
  private pruneClears(): void {
    let oldest = Infinity;
    for (const generation of this.inFlight.keys()) oldest = Math.min(oldest, generation);
    for (const clears of [this.userClears, this.pairClears]) {
      for (const [k, generation] of clears) {
        if (generation <= oldest) clears.delete(k);
      }
    }
  }
}
