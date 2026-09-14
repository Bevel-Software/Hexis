/**
 * The ONE piece of state the stateless MCP endpoint keeps between requests: a
 * pool of connections to proxied third-party MCP servers (`mcp.json` manuals),
 * keyed by (user, server).
 *
 * Everything else a request needs is re-derived from its own bearer. These
 * connections are the exception because a downstream MCP server is session-ful
 * by nature — dialing a fresh handshake on every tool call would add a round
 * trip per call and hammer the provider. So they are cached, and the pool is
 * built so that losing any of it costs a reconnect, never correctness:
 *
 *   - created LAZILY, on the first request that needs the server;
 *   - SINGLE-FLIGHT per key: concurrent first calls share one creation, so a
 *     burst produces one connection instead of N with all but one orphaned;
 *   - IDLE-EVICTED and SIZE-BOUNDED, with the retired session store's proven
 *     defaults (4 hours idle, 5000 entries);
 *   - every eviction CLOSES what it evicts (`dispose`) — the pool is the owner
 *     of each connection it opened, and nothing else closes them.
 *
 * Eviction is lazy, like the store it replaces: `acquire` sweeps idle entries
 * first and enforces the cap on insert. No background timer, so constructing a
 * pool never leaks an interval handle (in tests or anywhere else).
 *
 * Healing a connection whose server restarted is NOT this class's job: the
 * pooled value carries the existing session-recovery wrapper, which
 * re-registers on the spec's 404 in place. The pool only decides how long a
 * value lives.
 */

export interface DownstreamPoolOptions<V> {
  /** Close a value the pool is dropping. Errors are logged, never thrown. */
  dispose: (value: V) => Promise<void>;
  /** Drop entries unused for longer than this. Default: 4 hours. */
  idleTtlMs?: number;
  /** Hard cap on pooled entries; the least-recently-used is evicted first. Default: 5000. */
  maxEntries?: number;
  /** Override `Date.now` — injected only by tests. */
  now?: () => number;
}

export const DEFAULT_DOWNSTREAM_IDLE_TTL_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_DOWNSTREAM_MAX_ENTRIES = 5000;

interface Entry<V> {
  value: V;
  lastUsedAt: number;
}

interface Pending<V> {
  promise: Promise<V>;
  /** Set by `evictWhere` when the key is invalidated while creation is in flight. */
  stale: boolean;
}

export class DownstreamPool<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly pending = new Map<string, Pending<V>>();
  private readonly dispose: (value: V) => Promise<void>;
  private readonly idleTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: DownstreamPoolOptions<V>) {
    this.dispose = opts.dispose;
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_DOWNSTREAM_IDLE_TTL_MS;
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_DOWNSTREAM_MAX_ENTRIES);
    this.now = opts.now ?? Date.now;
  }

  /**
   * The pooled value for `key`, creating it with `create` when absent. Marks
   * the entry used. A creation that rejects is NOT cached — every waiter sees
   * the rejection and the next `acquire` tries again (retry pacing is the
   * caller's policy, see ManualFailureMemo).
   */
  async acquire(key: string, create: () => Promise<V>): Promise<V> {
    this.sweep();
    const hit = this.entries.get(key);
    if (hit) {
      hit.lastUsedAt = this.now();
      return hit.value;
    }
    const inflight = this.pending.get(key);
    if (inflight) return this.awaitPending(key, inflight, create);

    const record: Pending<V> = { promise: create(), stale: false };
    this.pending.set(key, record);
    const forget = () => {
      if (this.pending.get(key) === record) this.pending.delete(key);
    };
    let value: V;
    try {
      value = await record.promise;
    } finally {
      forget();
    }
    if (record.stale) {
      // Invalidated mid-creation (the user's credentials changed): the value
      // was built from the old state. Close it and build a current one.
      this.disposeQuietly(key, value);
      return this.acquire(key, create);
    }
    this.insert(key, value);
    return value;
  }

  /**
   * Evict (and close) every entry whose key matches — the hook for "this
   * user's credentials changed". A creation in flight for a matching key is
   * marked stale, so its result is closed and rebuilt instead of cached.
   */
  evictWhere(predicate: (key: string) => boolean): void {
    for (const [key, entry] of [...this.entries]) {
      if (!predicate(key)) continue;
      this.entries.delete(key);
      this.disposeQuietly(key, entry.value);
    }
    for (const [key, record] of this.pending) {
      if (predicate(key)) record.stale = true;
    }
  }

  /** Evict and close everything. */
  closeAll(): void {
    this.evictWhere(() => true);
  }

  /** Pooled (resolved) entries; diagnostics and tests. Does not sweep. */
  size(): number {
    return this.entries.size;
  }

  private async awaitPending(key: string, record: Pending<V>, create: () => Promise<V>): Promise<V> {
    const value = await record.promise;
    // The creator owns closing a stale value; a joiner just asks again.
    if (record.stale) return this.acquire(key, create);
    const entry = this.entries.get(key);
    if (entry) entry.lastUsedAt = this.now();
    return value;
  }

  private insert(key: string, value: V): void {
    this.sweep();
    while (this.entries.size >= this.maxEntries) this.evictLeastRecentlyUsed();
    this.entries.set(key, { value, lastUsedAt: this.now() });
  }

  private sweep(): void {
    const cutoff = this.now() - this.idleTtlMs;
    for (const [key, entry] of [...this.entries]) {
      if (entry.lastUsedAt < cutoff) {
        this.entries.delete(key);
        this.disposeQuietly(key, entry.value);
      }
    }
  }

  private evictLeastRecentlyUsed(): void {
    let oldestKey: string | undefined;
    let oldestUsed = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsedAt < oldestUsed) {
        oldestUsed = entry.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) return;
    const entry = this.entries.get(oldestKey)!;
    this.entries.delete(oldestKey);
    this.disposeQuietly(oldestKey, entry.value);
  }

  /**
   * Fire-and-forget close: a slow downstream teardown must not block the
   * request that happened to trigger the sweep, and a failing one must not
   * stop the rest of the sweep.
   */
  private disposeQuietly(key: string, value: V): void {
    void Promise.resolve()
      .then(() => this.dispose(value))
      .catch((err) => {
        console.warn(`[mcp] closing pooled downstream connection failed (${poolKeyLabel(key)}):`, err);
      });
  }
}

/** A log-safe rendering of a pool key: user and manual, never the template fingerprint. */
function poolKeyLabel(key: string): string {
  const [userId, manual] = key.split(POOL_KEY_SEPARATOR);
  return `user=${userId ?? '?'} manual=${manual ?? '?'}`;
}

/** Separator for (user, manual, fingerprint) keys — cannot occur in any of the parts. */
export const POOL_KEY_SEPARATOR = '\u0000';
