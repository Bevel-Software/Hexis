/**
 * The ONE tiny TTL cache for single-value catalog caches (tool manuals, skills):
 * hold a value for `ttlMs`, drop it on `invalidate()`. Caches that need more
 * (per-key entries, single-flight, generation guards — kb-graph, access-control)
 * deliberately keep their own.
 */
export class TtlCache<T> {
  private entry: { at: number; value: T } | null = null;
  /**
   * Bumped by every `invalidate()`. A fetch carries the value this had when it
   * started, and `set` refuses a value whose fetch straddled a drop — see there.
   */
  private generation = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(): T | null {
    if (this.entry && this.now() - this.entry.at < this.ttlMs) return this.entry.value;
    return null;
  }

  /**
   * Take a token BEFORE starting the fetch whose result you will `set`.
   *
   * Every caller of this cache reads the disk across an `await`, and the whole
   * point of `invalidate()` is that it fires during exactly that window: the
   * merge pulls the new tree in while a catalog read that started on the old
   * one is still in flight. Without a token that late `set` wins, and the cache
   * holds the PRE-invalidation scan for a fresh full TTL — the drop silently
   * undone, and the staleness it existed to prevent restored.
   */
  begin(): number {
    return this.generation;
  }

  /**
   * Store a value fetched under `token`. Required, not optional: a caller that
   * could forget it is a caller that reintroduces the race above, and there are
   * few enough call sites to make the token cheap.
   *
   * A stale token means an `invalidate()` landed mid-fetch, so this value
   * describes a tree that is already gone: it is DISCARDED rather than stored.
   * The fetcher still returns it to its own caller — that read is merely as old
   * as the moment it started, which is true of any read — but the next caller
   * re-scans instead of inheriting it.
   */
  set(value: T, token: number): void {
    if (token !== this.generation) return;
    this.entry = { at: this.now(), value };
  }

  invalidate(): void {
    this.entry = null;
    this.generation++;
  }
}
