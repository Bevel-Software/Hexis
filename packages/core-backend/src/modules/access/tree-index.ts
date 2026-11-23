/**
 * Every path a commit carries, as a cached at-ref model keeps it, and the
 * one place those paths are held for every cached commit at once.
 *
 * A model needs its commit's paths for one question: is this path absent at
 * the commit (a fact, remembered) or a blob the batch could not read (never
 * remembered)? Most paths are the same from one commit to the next, so an
 * index is a BASE set shared with the commits around it, plus what this
 * commit adds to it and takes from it. A path held by many cached commits is
 * then held once, and a commit costs what it changed.
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

  /** The paths this index holds that its base does not hold for it. */
  get ownPaths(): number {
    return this.added.size + this.removed.size;
  }
}

/**
 * Builds the indexes and counts what the held ones cost together: each base
 * once, however many indexes share it, plus every index's own paths. A base
 * is kept only while a held index uses it; when the last one is released,
 * nothing here points at it.
 */
export class TreeIndexer {
  /** The base new indexes are built against: the newest held one. */
  private latestBase: ReadonlySet<string> | null = null;
  private readonly baseHolders = new Map<ReadonlySet<string>, number>();
  private held = 0;

  /**
   * A new base is started when a commit differs from the current one by more
   * than this share of its paths, so an index never costs more than that
   * share of a full tree.
   */
  private static readonly MAX_DELTA_SHARE = 1 / 16;

  /** The index of a commit whose listing is `paths` (unique, as git lists them). */
  index(paths: readonly string[]): CommitTreeIndex {
    const current = new Set(paths);
    const base = this.latestBase;
    if (base) {
      const added: string[] = [];
      for (const p of current) if (!base.has(p)) added.push(p);
      const removedCount = base.size - (current.size - added.length);
      if (added.length + removedCount <= base.size * TreeIndexer.MAX_DELTA_SHARE) {
        const removed: string[] = [];
        if (removedCount > 0) for (const p of base) if (!current.has(p)) removed.push(p);
        return new CommitTreeIndex(
          base,
          added.length ? new Set(added) : EMPTY,
          removed.length ? new Set(removed) : EMPTY,
        );
      }
    }
    return new CommitTreeIndex(current, EMPTY, EMPTY);
  }

  /** Count `index` as held by a cached model. */
  hold(index: CommitTreeIndex): void {
    const holders = this.baseHolders.get(index.base) ?? 0;
    if (holders === 0) this.held += index.base.size;
    this.baseHolders.set(index.base, holders + 1);
    this.held += index.ownPaths;
    this.latestBase = index.base;
  }

  /** The model holding `index` let it go. */
  release(index: CommitTreeIndex): void {
    const holders = this.baseHolders.get(index.base) ?? 0;
    this.held -= index.ownPaths;
    if (holders <= 1) {
      this.baseHolders.delete(index.base);
      if (holders === 1) this.held -= index.base.size;
      if (this.latestBase === index.base) this.latestBase = null;
    } else {
      this.baseHolders.set(index.base, holders - 1);
    }
  }

  /** Paths held across every held index, each shared base counted once. */
  get heldPaths(): number {
    return this.held;
  }
}
