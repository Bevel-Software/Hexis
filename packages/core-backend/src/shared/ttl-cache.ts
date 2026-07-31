/**
 * The ONE tiny TTL cache for single-value catalog caches (tool manuals, skills):
 * hold a value for `ttlMs`, drop it on `invalidate()`. Caches that need more
 * (per-key entries, single-flight, generation guards — kb-graph, access-control)
 * deliberately keep their own.
 */
export class TtlCache<T> {
  private entry: { at: number; value: T } | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(): T | null {
    if (this.entry && this.now() - this.entry.at < this.ttlMs) return this.entry.value;
    return null;
  }

  set(value: T): void {
    this.entry = { at: this.now(), value };
  }

  invalidate(): void {
    this.entry = null;
  }
}
