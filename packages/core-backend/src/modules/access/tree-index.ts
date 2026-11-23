/**
 * Every path a commit carries, as a cached at-ref model keeps it, and the
 * one place those paths are held for every cached commit at once.
 *
 * A model needs its commit's paths for one question: is this path absent at
 * the commit (a fact, remembered) or a blob the batch could not read (never
 * remembered)? Most paths are the same from one commit to the next, so an
 * index is a BASE set shared with the commits around it, plus what this
 * commit adds to it and takes from it. A path held by the cached commits that
 * share a base is then held once, and such a commit costs what it changed.
 *
 * The strings come from {@link parseNulListing}, which decodes each path from
 * the bytes git printed: a path is a string of its own, never a view onto the
 * listing, so nothing an index keeps holds a listing alive.
 */

/** Split `git ls-tree -z` output into paths, each decoded on its own from the bytes. */
export function parseNulListing(bytes: Buffer): string[] {
  const out: string[] = [];
  let off = 0;
  while (off < bytes.length) {
    let end = bytes.indexOf(0, off);
    if (end < 0) end = bytes.length;
    if (end > off) out.push(bytes.toString('utf8', off, end));
    off = end + 1;
  }
  return out;
}

const EMPTY: ReadonlySet<string> = new Set();

/** The paths of one commit: a shared base, plus what this commit adds and takes away. */
export class CommitTreeIndex {
  constructor(
    /** Shared with the other indexes built against it; read by {@link TreeIndexer} only. */
    readonly base: ReadonlySet<string>,
    private readonly added: ReadonlySet<string>,
    private readonly removed: ReadonlySet<string>,
  ) {}

  has(p: string): boolean {
    return this.added.has(p) || (this.base.has(p) && !this.removed.has(p));
  }

  /** The paths this index adds to its base or removes from it. */
  get ownPaths(): number {
    return this.added.size + this.removed.size;
  }
}

/**
 * Builds the indexes and counts what the held ones cost together: each base
 * once, however many indexes share it, plus every index's own paths. A base
 * is kept only while a held index uses it; when the last one is released,
 * nothing here points at it.
 *
 * A new index is built against the CLOSEST of the most recently held bases,
 * not only the newest one. The service caches the commits of every workspace
 * in one place, and two workspaces whose branches differ by more than the
 * delta share (a draft that added a folder, say) build in turn: against the
 * newest base alone, each would start a full base of its own whenever the
 * other had built last; against the closest recent one, each finds its own.
 */
export class TreeIndexer {
  /** Held bases, most recently held first: the candidates a new index is built against. */
  private readonly recentBases: ReadonlySet<string>[] = [];
  private readonly baseHolders = new Map<ReadonlySet<string>, number>();
  private held = 0;

  /**
   * A new base is started when a commit differs from every candidate by more
   * than this share of the candidate's paths, so an index never costs more
   * than that share of a full tree.
   */
  private static readonly MAX_DELTA_SHARE = 1 / 16;
  /**
   * Candidates compared per build, at most. A comparison is up to one set
   * lookup per path, so this caps a build's work; more lines of history than
   * this, built in turn, each start a base of their own.
   */
  private static readonly MAX_CANDIDATES = 8;

  /** The index of a commit whose listing is `paths` (unique, as git lists them). */
  index(paths: readonly string[]): CommitTreeIndex {
    const current = new Set(paths);
    let best: { base: ReadonlySet<string>; added: string[]; delta: number } | null = null;
    for (const base of this.recentBases) {
      // A candidate wins only with a smaller delta than the best so far and
      // within the share; counting stops as soon as it cannot.
      const limit = Math.min(base.size * TreeIndexer.MAX_DELTA_SHARE, best ? best.delta - 1 : Infinity);
      const added: string[] = [];
      for (const p of current) {
        if (base.has(p)) continue;
        added.push(p);
        if (added.length > limit) break;
      }
      if (added.length > limit) continue;
      const delta = added.length + base.size - (current.size - added.length);
      if (delta > limit) continue;
      best = { base, added, delta };
    }
    if (!best) return new CommitTreeIndex(current, EMPTY, EMPTY);
    const removed: string[] = [];
    if (best.delta > best.added.length) for (const p of best.base) if (!current.has(p)) removed.push(p);
    return new CommitTreeIndex(
      best.base,
      best.added.length ? new Set(best.added) : EMPTY,
      removed.length ? new Set(removed) : EMPTY,
    );
  }

  /** Count `index` as held by a cached model. */
  hold(index: CommitTreeIndex): void {
    const holders = this.baseHolders.get(index.base) ?? 0;
    if (holders === 0) this.held += index.base.size;
    this.baseHolders.set(index.base, holders + 1);
    this.held += index.ownPaths;
    this.forget(index.base);
    this.recentBases.unshift(index.base);
    if (this.recentBases.length > TreeIndexer.MAX_CANDIDATES) {
      this.recentBases.length = TreeIndexer.MAX_CANDIDATES;
    }
  }

  /** The model holding `index` let it go. */
  release(index: CommitTreeIndex): void {
    const holders = this.baseHolders.get(index.base) ?? 0;
    this.held -= index.ownPaths;
    if (holders <= 1) {
      this.baseHolders.delete(index.base);
      if (holders === 1) this.held -= index.base.size;
      this.forget(index.base);
    } else {
      this.baseHolders.set(index.base, holders - 1);
    }
  }

  /** Paths held across every held index, each shared base counted once. */
  get heldPaths(): number {
    return this.held;
  }

  private forget(base: ReadonlySet<string>): void {
    const at = this.recentBases.indexOf(base);
    if (at >= 0) this.recentBases.splice(at, 1);
  }
}
