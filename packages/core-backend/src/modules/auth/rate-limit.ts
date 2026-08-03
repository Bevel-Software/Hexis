/**
 * Tiny fixed-window in-memory rate limiter for the password endpoints —
 * brute-force / scrypt-DoS protection, not traffic shaping. In-memory is the
 * right scope for the single-instance deployment model (same assumption as
 * the MCP session store); a multi-replica future moves this behind a shared
 * store.
 *
 * Expired windows are pruned opportunistically on each hit so the map stays
 * bounded by the number of DISTINCT active keys per window.
 */
export class FixedWindowRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    /** Attempts allowed per window per key. */
    private readonly max: number,
    private readonly windowMs: number,
    /** Injectable clock for tests. */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record one attempt for `key`; returns true when the attempt is ALLOWED
   * (i.e. the key is within its budget for the current window).
   */
  consume(key: string): boolean {
    const now = this.now();
    for (const [k, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  /** Clear a key's window — called after a SUCCESSFUL login so legitimate
   * users who fumbled a few attempts aren't locked out of their next visit. */
  reset(key: string): void {
    this.hits.delete(key);
  }
}
