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
 *     of each connection it opened, and nothing else closes them;
 *   - LEASED: `acquire` hands out a lease the caller releases when its
 *     operation ends. A leased entry is in use, so it is never idle and never
 *     the LRU victim; an entry invalidated while leased leaves the pool at once
 *     but is closed only when its last lease is released. A call in progress
 *     never has its connection closed underneath it.
 *
 * Eviction is lazy, like the store it replaces: `acquire` sweeps idle entries
 * first and enforces the cap on insert. No background timer, so constructing a
 * pool never leaks an interval handle (in tests or anywhere else). When every
 * entry is leased the cap cannot evict anything, and the pool holds more than
 * `maxEntries` until leases are released — and the release that ends an
 * entry's last lease re-applies the cap, so the overflow ends with the leases,
 * not with whenever the next acquire happens to run.
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

/** A pooled value in use. `release` ends the use; calling it again is a no-op. */
export interface Lease<V> {
  readonly value: V;
  release(): void;
}

export const DEFAULT_DOWNSTREAM_IDLE_TTL_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_DOWNSTREAM_MAX_ENTRIES = 5000;

interface Entry<V> {
  key: string;
  value: V;
  lastUsedAt: number;
  /** Outstanding leases; an entry with any is in use and not evictable. */
  leases: number;
  /** Removed from the pool while leased: close it when the last lease ends. */
  retired: boolean;
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
   * Lease the pooled value for `key`, creating it with `create` when absent.
   * The caller MUST release the lease when its operation ends (try/finally).
   * A creation that rejects is NOT cached — every waiter sees the rejection and
   * the next `acquire` tries again (retry pacing is the caller's policy, see
   * ManualFailureMemo).
   */
  async acquire(key: string, create: () => Promise<V>): Promise<Lease<V>> {
    this.sweep();
    const hit = this.entries.get(key);
    if (hit) return this.lease(hit);
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
    return this.lease(this.insert(key, value));
  }

  /**
   * Evict every entry whose key matches — the hook for "this user's
   * credentials changed". Idle entries are closed now; leased ones leave the
   * pool now and are closed when released. A creation in flight for a matching
   * key is marked stale, so its result is closed and rebuilt instead of cached.
   */
  evictWhere(predicate: (key: string) => boolean): void {
    for (const [key, entry] of [...this.entries]) {
      if (predicate(key)) this.retire(entry);
    }
    for (const [key, record] of this.pending) {
      if (predicate(key)) record.stale = true;
    }
  }

  /** Evict and close everything (leased entries close on release). */
  closeAll(): void {
    this.evictWhere(() => true);
  }

  /** Pooled (resolved) entries; diagnostics and tests. Does not sweep. */
  size(): number {
    return this.entries.size;
  }

  private async awaitPending(key: string, record: Pending<V>, create: () => Promise<V>): Promise<Lease<V>> {
    const value = await record.promise;
    // The creator owns closing a stale value; a joiner just asks again.
    if (record.stale) return this.acquire(key, create);
    // The creator pooled the value before this continuation ran. If it has
    // already left the pool again, lease whatever the pool holds now.
    const entry = this.entries.get(key);
    if (!entry || entry.value !== value) return this.acquire(key, create);
    return this.lease(entry);
  }

  private lease(entry: Entry<V>): Lease<V> {
    entry.leases += 1;
    entry.lastUsedAt = this.now();
    let released = false;
    return {
      value: entry.value,
      release: () => {
        if (released) return;
        released = true;
        entry.leases -= 1;
        // Idleness is measured from the end of the last use.
        entry.lastUsedAt = this.now();
        if (entry.retired && entry.leases === 0) this.disposeQuietly(entry.key, entry.value);
        // An insert that found every entry leased could not evict and let the
        // pool overflow the cap. The overflow has to end with the leases, not
        // with whenever the next acquire happens to run — so the release that
        // ends an entry's last lease re-applies the cap. The entry just
        // released is the newest by `lastUsedAt`, so older idle entries go
        // first.
        if (entry.leases === 0) this.enforceCap();
      },
    };
  }

  private insert(key: string, value: V): Entry<V> {
    this.sweep();
    this.enforceCap(1);
    const entry: Entry<V> = { key, value, lastUsedAt: this.now(), leases: 0, retired: false };
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Evict idle entries, least recently used first, until at most
   * `maxEntries - reserve` remain — or nothing idle is left, in which case
   * the pool stays over the cap until a lease is released (which calls this
   * again). `reserve` is the room an insert needs for the entry it is about
   * to add.
   */
  private enforceCap(reserve = 0): void {
    while (this.entries.size + reserve > this.maxEntries && this.evictLeastRecentlyUsed()) {
      // each pass evicted one idle entry
    }
  }

  private sweep(): void {
    const cutoff = this.now() - this.idleTtlMs;
    for (const entry of [...this.entries.values()]) {
      if (entry.leases === 0 && entry.lastUsedAt < cutoff) this.retire(entry);
    }
  }

  /** Evict the least-recently-used entry not in use; false when every entry is leased. */
  private evictLeastRecentlyUsed(): boolean {
    let oldest: Entry<V> | undefined;
    for (const entry of this.entries.values()) {
      if (entry.leases > 0) continue;
      if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) oldest = entry;
    }
    if (!oldest) return false;
    this.retire(oldest);
    return true;
  }

  /** Take an entry out of the pool; close it now, or on its last release when leased. */
  private retire(entry: Entry<V>): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    entry.retired = true;
    if (entry.leases === 0) this.disposeQuietly(entry.key, entry.value);
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
