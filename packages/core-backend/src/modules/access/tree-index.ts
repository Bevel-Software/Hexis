/**
 * Every path a commit carries, as a cached at-ref model keeps it, and the
 * one place those paths are held for every commit one service graph caches.
 *
 * A model needs its commit's paths for one question: is this path absent at
 * the commit (a fact, remembered) or a blob the batch could not read (never
 * remembered)? Most paths are the same from one commit to the next, so an
 * index is a BASE set shared with the commits around it, plus what this
 * commit adds to it and takes from it. A path held by the cached commits that
 * share a base is then held once, and such a commit costs what it changed.
 *
 * The strings come from `visitTreeListing` (`commit-listing.ts`), which
 * decodes each path from the bytes git printed: a path is a string of its own,
 * never a view onto the listing, so nothing an index keeps holds a listing
 * alive.
 */

/** What a cached at-ref model asks of its commit's paths. */
export interface CommitPaths {
  /** Whether the commit carries `p`. */
  has(p: string): boolean;
}

/**
 * The contract the access service holds its commits' trees through: builds a
 * commit's {@link CommitPaths}, and counts what the ones a cached model holds
 * cost together. {@link TreeIndexer} is the implementation the composition
 * root wires.
 */
export interface ITreeIndexer {
  /** The paths of a commit whose listing is `paths` (unique, as git lists them). */
  index(paths: readonly string[]): CommitPaths;
  /** Count `tree`, which this indexer built, as held by a cached model. */
  hold(tree: CommitPaths): void;
  /** The model holding `tree`, which this indexer built, let it go. */
  release(tree: CommitPaths): void;
  /** Paths held across every held tree, as the implementation counts what they share. */
  readonly heldPaths: number;
}

const EMPTY: ReadonlySet<string> = new Set();

/** The paths of one commit: a shared base, plus what this commit adds and takes away. */
class CommitTreeIndex implements CommitPaths {
  constructor(
    /** The indexer that built this index, the only one that may hold or release it. */
    readonly indexer: TreeIndexer,
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
export class TreeIndexer implements ITreeIndexer {
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
  index(paths: readonly string[]): CommitPaths {
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
    if (!best) return new CommitTreeIndex(this, current, EMPTY, EMPTY);
    const removed: string[] = [];
    if (best.delta > best.added.length) for (const p of best.base) if (!current.has(p)) removed.push(p);
    return new CommitTreeIndex(
      this,
      best.base,
      best.added.length ? new Set(best.added) : EMPTY,
      removed.length ? new Set(removed) : EMPTY,
    );
  }

  /** Count `tree` as held by a cached model. */
  hold(tree: CommitPaths): void {
    const index = this.built(tree);
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

  /** The model holding `tree` let it go. */
  release(tree: CommitPaths): void {
    const index = this.built(tree);
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

  /**
   * `tree` as this indexer built it. Holding or releasing a tree another
   * indexer built would corrupt both counts, so it is refused.
   */
  private built(tree: CommitPaths): CommitTreeIndex {
    if (tree instanceof CommitTreeIndex && tree.indexer === this) return tree;
    throw new TypeError('TreeIndexer: a tree this indexer did not build');
  }

  private forget(base: ReadonlySet<string>): void {
    const at = this.recentBases.indexOf(base);
    if (at >= 0) this.recentBases.splice(at, 1);
  }
}
