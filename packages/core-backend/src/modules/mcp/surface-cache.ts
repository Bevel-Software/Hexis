/**
 * The hosted MCP server's memory of built tool surfaces: one per caller and
 * catalog revision, built once and reused until something it was built from
 * changes.
 *
 * Keyed by whatever the service says identifies a surface — the person, the
 * kind of caller, the key's scope and the catalog revision. A catalog change
 * needs no listener: it is a new revision, so a new key, and the old entry
 * ages out unused. What the revision cannot see (a secret) is evicted
 * explicitly through {@link evictWhere} / {@link clear}.
 *
 * Bounded twice: an entry unused for `idleTtlMs` is dropped, and at most
 * `maxEntries` are held, the least recently used going first. `maxEntries: 0`
 * keeps nothing, which is the per-request build this replaced: the escape
 * hatch if the cache ever has to be switched off.
 *
 * Single-flight: concurrent misses on one key share one build. A build that
 * fails is not remembered, so the next request tries again. A build that was
 * in flight when its key was evicted answers the requests waiting on it but is
 * not kept: it was built from what the eviction said is stale. A build still
 * running after `buildTimeoutMs` is let go the same way, so a discovery that
 * hangs holds up the requests already waiting on it, not every later one.
 *
 * Holds references only. A surface owns no connection (its `mcp` manuals route
 * to the downstream pool, which owns and closes those), so dropping an entry
 * is the whole teardown.
 */
export interface SurfaceCacheOptions {
  /** Drop an entry unused for this long. Default one hour. */
  idleTtlMs?: number;
  /** Hold at most this many entries. Default 500; 0 keeps nothing. */
  maxEntries?: number;
  /** Let go of a build still running after this long; the next request starts another. Default two minutes. */
  buildTimeoutMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export const SURFACE_IDLE_TTL_MS = 60 * 60 * 1000;
export const SURFACE_BUILD_TIMEOUT_MS = 2 * 60 * 1000;
export const SURFACE_MAX_ENTRIES = 500;

interface Entry<V> {
  value: Promise<V>;
  startedAt: number;
  lastUsed: number;
  /** An absolute end, for a value that must not live its full idle time (see `maxAgeMs`). */
  expiresAt: number;
  /** False once the entry was evicted while its build was still running. */
  live: boolean;
  settled: boolean;
}

export class SurfaceCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly idleTtlMs: number;
  private readonly maxEntries: number;
  private readonly buildTimeoutMs: number;
  private readonly now: () => number;

  constructor(opts: SurfaceCacheOptions = {}) {
    this.idleTtlMs = opts.idleTtlMs ?? SURFACE_IDLE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? SURFACE_MAX_ENTRIES;
    this.buildTimeoutMs = opts.buildTimeoutMs ?? SURFACE_BUILD_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * The value for `key`, built by `build` when none is held. `hit` says
   * whether this call found one (or joined a build already running).
   *
   * `maxAgeMs`, read off a built value, ends that entry early whatever its
   * use: a surface built while one of its manuals was failing is kept only
   * as long as that failure would be remembered anyway.
   */
  async get(
    key: string,
    build: () => Promise<V>,
    maxAgeMs?: (value: V) => number | undefined,
  ): Promise<{ value: V; hit: boolean }> {
    this.sweep();
    const now = this.now();
    const held = this.entries.get(key);
    if (held) {
      held.lastUsed = now;
      // Most recently used goes last, so the first entry is always the one to drop.
      this.entries.delete(key);
      this.entries.set(key, held);
      return { value: await held.value, hit: true };
    }
    if (this.maxEntries <= 0) return { value: await build(), hit: false };
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    const entry: Entry<V> = {
      value: build(),
      startedAt: now,
      lastUsed: now,
      expiresAt: Number.POSITIVE_INFINITY,
      live: true,
      settled: false,
    };
    this.entries.set(key, entry);
    try {
      const value = await entry.value;
      entry.settled = true;
      const maxAge = maxAgeMs?.(value);
      if (maxAge !== undefined) entry.expiresAt = this.now() + maxAge;
      if (!entry.live) this.forget(key, entry);
      return { value, hit: false };
    } catch (err) {
      this.forget(key, entry);
      throw err;
    }
  }

  /** Drop every entry whose key matches. A build in flight still answers its waiters, and is not kept. */
  evictWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) {
      if (predicate(key)) this.drop(key);
    }
  }

  /** Drop everything. */
  clear(): void {
    this.evictWhere(() => true);
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.live = false;
    this.entries.delete(key);
  }

  /** Remove `entry` only if it is still the one under `key` (a newer build may have taken its place). */
  private forget(key: string, entry: Entry<V>): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }

  /** Drop what has been idle too long, or outlived its own end, and let go of a build that has run too long. */
  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (!entry.settled) {
        if (now - entry.startedAt >= this.buildTimeoutMs) this.drop(key);
        continue;
      }
      if (now - entry.lastUsed >= this.idleTtlMs || now >= entry.expiresAt) this.drop(key);
    }
  }
}
