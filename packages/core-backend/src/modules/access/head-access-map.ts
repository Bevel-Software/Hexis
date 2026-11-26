import { logger } from '../../shared/logging.js';
import type { IGitRunner } from '../../shared/git.contract.js';
import { readRevSha } from '../kb-fs/index.js';
import { accessMdSelfEntries, isAccessMdPath, parseOwnAccessEntries, type OwnEntries } from '../access-model/index.js';
import { catFileBatchBytes } from './cat-file-batch.js';
import { visitTreeListing, type ListedFile } from './commit-listing.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { frontmatterHeadOfBytes, frontmatterHeadOfWholeFile } from './frontmatter-head.js';
import { detachEntries } from './own-entries-memo.js';
import { mapPooled } from '../../shared/map-pooled.js';
import type { CommitPaths, ITreeIndexer } from './tree-index.js';

const log = logger('access');

/**
 * What a branch's reads are answered from: the access rules of the commit
 * its checkout stands on, and what each file of that commit declares for
 * itself.
 *
 * A map holds the rules, not an answer per file: `model` is the access model
 * of the commit (shared with every commit that has the same access files),
 * and `ownEntries` knows the few files that declare access of their own. A
 * file that declares nothing is in no list here and is never opened to
 * answer a question about it.
 */
export interface HeadMap<M> {
  /** The commit the map was made from. */
  readonly commit: string;
  readonly model: M;
  /**
   * What the file at `p` declares for itself at the commit: its entries, or
   * null for nothing (a folder of the commit declares nothing). `undefined`
   * when the commit does not hold `p`: a file written and not committed
   * yet, or one git does not track. The checkout is then the only place
   * that can say.
   */
  ownEntries(p: string): OwnEntries | null | undefined;
}

/** How much the maps may hold, and how much a caller waits for. */
export interface HeadMapLimits {
  /** Maps held at most, least recently asked dropped first. */
  readonly maxHeads: number;
  /** Paths held at most across the held maps' trees, each shared base once. */
  readonly maxTreePaths: number;
  /** File versions remembered at most (what each declares, mostly nothing), oldest dropped first. */
  readonly maxBlobs: number;
  /**
   * Bytes of file versions never seen before that a caller waits for. A
   * commit that needs more (the first one after a start) is read in the
   * background, and its callers are answered the old way until it is ready.
   */
  readonly waitBytes: number;
  /** Bytes read from git in one process, at most (one file larger than this is read alone). */
  readonly chunkBytes: number;
  /** The seed is saved at most this often. */
  readonly saveEveryMs: number;
}

export const HEAD_MAP_LIMITS: HeadMapLimits = {
  maxHeads: 64,
  maxTreePaths: 2_000_000,
  maxBlobs: 1_000_000,
  waitBytes: 8 * 1024 * 1024,
  chunkBytes: 16 * 1024 * 1024,
  saveEveryMs: 60_000,
};

/**
 * What a start begins from: a commit a map was made of, and the files of it
 * that declare access of their own, each with the id of the version that
 * does. Every other file of that commit declares nothing.
 */
export interface HeadSeed {
  readonly commit: string;
  readonly declaring: ReadonlyArray<readonly [path: string, objectId: string]>;
}

/** Where the seed is kept between starts. */
export interface IHeadSeedStore {
  /** The seed last saved, or null when there is none this release may read. */
  load(): Promise<HeadSeed | null>;
  save(seed: HeadSeed): Promise<void>;
}

/**
 * What {@link HeadMaps} asks of the access service: the access model of a
 * commit, as the checkout standing on it reads it.
 */
export interface HeadModelSource<M> {
  /**
   * The model at `commit`, with `visit` called for every file the commit
   * lists. `release` is called once, when the map made from it is dropped.
   * Null when no model can be read from the commit (no roles file, one that
   * does not parse, a git read that failed): the caller answers the old way.
   */
  modelAt(
    repoDir: string,
    commit: string,
    visit: (path: string, file: ListedFile) => void,
  ): Promise<{ model: M; release(): void } | null>;
}

/**
 * The contract the access service holds the head maps through. {@link HeadMaps}
 * is the implementation the composition root wires.
 */
export interface IHeadMaps<M> {
  /** The commit the checkout at `repoDir` stands on, read from the ref files; null when they do not say. */
  headOf(repoDir: string): Promise<string | null>;
  /**
   * The map of `commit`, which the checkout at `repoDir` stands on, its
   * model read through `source` when it is not held. Null when there is none
   * to answer from right now: the caller answers from the checkout.
   */
  at(repoDir: string, commit: string, source: HeadModelSource<M>): Promise<HeadMap<M> | null>;
}

interface Held<M> {
  readonly map: HeadMap<M>;
  readonly tree: CommitPaths;
  release(): void;
}

/** A file version not seen before: its object, and the paths that hold it. */
interface Unseen {
  readonly objectId: string;
  readonly key: string;
  readonly size: number;
  readonly paths: string[];
}

/**
 * The maps of the commits that checkouts stand on, by commit.
 *
 * A new commit costs one listing (inside `modelAt`) and one read of the file
 * versions it holds that no earlier commit held: a save changes one file, so
 * a head that moves reads one file. What a file version declares is
 * remembered by its object id, so a version is read once for every branch
 * and commit that holds it.
 *
 * Versions are read from the checkout where its copy is the version's own
 * bytes: read whole, they hash to the version's object id (`readAtCheckout`).
 * A file git's stat cache says differs (`git diff-index <commit>`) is not
 * tried; it and any copy that is other bytes are read through git, so the
 * map, the memo and the seed hold only facts true of the commit's versions.
 * A change on disk counts once it is a commit, whose changed files are read
 * like any other's.
 *
 * A commit that lists a symbolic link or a submodule gets no map: what the
 * checkout holds there is not what the commit holds, and the old way reads
 * the checkout.
 */
export class HeadMaps<M> implements IHeadMaps<M> {
  /** In the order they were last asked for. */
  private readonly heads = new Map<string, Held<M>>();
  private readonly building = new Map<string, Promise<HeadMap<M> | null>>();
  /** Commits being read in the background (see `HeadMapLimits.waitBytes`). */
  private readonly warming = new Set<string>();
  /**
   * Commits no map is made from, each until a time: forever for a commit
   * that cannot have one (a symbolic link, no roles file; a commit does not
   * change), and `RETRY_MS` for one whose read failed, which may succeed
   * next time. Either way they are not tried on every call.
   */
  private readonly without = new Map<string, number>();
  private static readonly WITHOUT_MAX = 256;
  private static readonly RETRY_MS = 30_000;
  /** What each file version seen declares for itself, by `blobKey`. */
  private readonly blobs = new Map<string, OwnEntries | null>();

  constructor(
    private readonly git: IGitRunner,
    private readonly trees: ITreeIndexer,
    private readonly limits: HeadMapLimits = HEAD_MAP_LIMITS,
    /** Where the seed is kept between starts; without one every start reads the files again. */
    private readonly store?: IHeadSeedStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** The one read of the stored seed, started by the first build. */
  private seeding: Promise<void> | null = null;
  private savedAt = Number.NEGATIVE_INFINITY;

  /**
   * Begin from the stored seed, once: every file version of the seed's
   * commit is remembered as declaring nothing, but the listed ones, which
   * are read. The first map then reads only what changed since that commit.
   * A seed that cannot be used (its commit is gone, git failed) is left
   * aside, and the first map reads every file version, as without a store.
   */
  private seed(repoDir: string): Promise<void> {
    if (!this.store) return Promise.resolve();
    this.seeding ??= this.applySeed(repoDir, this.store).catch((err: unknown) => {
      log.warn(`the stored access seed was not used: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.seeding;
  }

  private async applySeed(repoDir: string, store: IHeadSeedStore): Promise<void> {
    const seed = await store.load();
    if (!seed) return;
    const declared = new Map(seed.declaring);
    const { stdout } = await this.git.run(repoDir, ['ls-tree', '-r', '-z', seed.commit], { encoding: 'buffer' });
    const nothing: string[] = [];
    const toRead = new Map<string, Unseen>();
    visitTreeListing(stdout, (path, file) => {
      // Only ordinary files have a version to remember; this listing is made
      // without folders' own records, and a link or a submodule is skipped.
      if (!file.regular || path === 'roles.yaml') return;
      const objectId = file.objectId();
      const key = blobKey(objectId, path);
      if (declared.get(path) === objectId) toRead.set(key, { objectId, key, size: 0, paths: [path] });
      else nothing.push(key);
    });
    await this.read(repoDir, [...toRead.values()], new Map());
    for (const key of nothing) if (!this.blobs.has(key)) this.rememberBlob(key, null);
  }

  async headOf(repoDir: string): Promise<string | null> {
    const head = await readRevSha(repoDir, 'HEAD');
    return typeof head === 'string' ? null : head.sha;
  }

  async at(repoDir: string, commit: string, source: HeadModelSource<M>): Promise<HeadMap<M> | null> {
    const held = this.heads.get(commit);
    if (held) {
      this.heads.delete(commit);
      this.heads.set(commit, held);
      return held.map;
    }
    const until = this.without.get(commit);
    if (until !== undefined) {
      if (this.now() < until) return null;
      this.without.delete(commit);
    }
    if (this.warming.has(commit)) return null;
    let pending = this.building.get(commit);
    if (!pending) {
      pending = this.build(repoDir, commit, source).finally(() => {
        if (this.building.get(commit) === pending) this.building.delete(commit);
      });
      this.building.set(commit, pending);
    }
    return pending;
  }

  private async build(repoDir: string, commit: string, source: HeadModelSource<M>): Promise<HeadMap<M> | null> {
    const paths: string[] = [];
    const own = new Map<string, OwnEntries>();
    const unseen = new Map<string, Unseen>();
    const declaring: Array<[string, string]> = [];
    let irregular = false;
    let wait = 0;
    await this.seed(repoDir);
    const built = await source.modelAt(repoDir, commit, (path, file) => {
      if (!file.regular) {
        irregular = true;
        return;
      }
      paths.push(path);
      // Never a node, wherever the rules are read from (`readOwnEntries`).
      if (path === 'roles.yaml') return;
      const objectId = file.objectId();
      const key = blobKey(objectId, path);
      const known = this.blobs.get(key);
      if (known !== undefined) {
        if (known !== null) {
          own.set(path, known);
          declaring.push([path, objectId]);
        }
        return;
      }
      const waiting = unseen.get(key);
      if (waiting) {
        waiting.paths.push(path);
        return;
      }
      unseen.set(key, { objectId, key, size: file.size, paths: [path] });
      // A version is read whole, from the checkout or through git: only its bytes prove a checkout's copy is it.
      wait += file.size;
    });
    if (!built || irregular) {
      built?.release();
      // A link or a submodule is a fact about the commit. No model may be
      // one too (no roles file) or a read that failed: tried again later.
      this.rememberWithout(commit, irregular && built ? Number.POSITIVE_INFINITY : this.now() + HeadMaps.RETRY_MS);
      return null;
    }
    const finish = async (): Promise<HeadMap<M> | null> => {
      try {
        await this.readAtCheckout(repoDir, commit, [...unseen.values()], own);
      } catch (err) {
        built.release();
        this.rememberWithout(commit, this.now() + HeadMaps.RETRY_MS);
        log.warn(
          `reading what the files of ${commit.slice(0, 7)} declare failed; answering from the checkout: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
      for (const u of unseen.values()) {
        if (own.has(u.paths[0]!)) for (const p of u.paths) declaring.push([p, u.objectId]);
      }
      this.save({ commit, declaring });
      return this.hold(commit, built, paths, own);
    };
    if (wait <= this.limits.waitBytes) return finish();
    this.warming.add(commit);
    void finish().finally(() => this.warming.delete(commit));
    return null;
  }

  /**
   * Read the versions in `unseen` for the map of `commit`, which the checkout at `repoDir` stands on: from the
   * checkout where its copy is the version's own bytes, through git everywhere else. A copy is read whole, and is
   * the version when its bytes hash to the version's object id. Git's stat cache (`diff-index`) only spares that
   * read for a file git already knows differs: it calls a file the same after git's filters, end-of-line conversion
   * and `working-tree-encoding` have run, under whatever attributes and configuration held when the file was
   * written out, so it is no proof the bytes are the version's. The hash is, whatever wrote the file and whenever,
   * a write during the read included. Remembers what each version declares and notes the ones that declare
   * something in `own`, as `read` does. The map holds the commit's versions only, never a newer one on disk: its
   * model is the commit's, and a page read as the disk has it beside rules read as the commit has them could pair a
   * restriction's old place with its new one, and keep it nowhere.
   */
  private async readAtCheckout(repoDir: string, commit: string, unseen: Unseen[], own: Map<string, OwnEntries>): Promise<void> {
    const changed = await this.changedOnDisk(repoDir, commit);
    // An `access.md` says what it declares for itself only with its body read too (`accessMdSelfEntries`): it goes
    // through git, in parts, as before. There are few, and they are small.
    const fromDisk = unseen.filter((u) => !isAccessMdPath(u.paths[0]!) && !u.paths.some((p) => changed.has(p)));
    const onDisk = new Set(fromDisk);
    const viaGit = unseen.filter((u) => !onDisk.has(u));
    const read = await mapPooled(fromDisk, DISK_READS_AT_ONCE, (u) => readDeclaredOnDisk(repoDir, u.paths[0]!, u.size, u.objectId));
    fromDisk.forEach((u, i) => {
      const declared = read[i]!;
      if (declared === UNVOUCHED) {
        viaGit.push(u);
        return;
      }
      this.rememberBlob(u.key, declared);
      if (declared !== null) for (const p of u.paths) own.set(p, declared);
    });
    await this.read(repoDir, viaGit, own);
  }

  /** The files whose state on disk differs from `commit` (staged or not), from git's stat cache: no file is read. */
  private async changedOnDisk(repoDir: string, commit: string): Promise<Set<string>> {
    const { stdout } = await this.git.run(repoDir, ['diff-index', '--name-only', '-z', commit, '--'], { encoding: 'buffer' });
    const changed = new Set<string>();
    for (let off = 0; off < stdout.length; ) {
      let end = stdout.indexOf(0, off);
      if (end < 0) end = stdout.length;
      if (end > off) changed.add(stdout.toString('utf8', off, end));
      off = end + 1;
    }
    return changed;
  }

  /** Read the versions in `unseen` from git, remember what each declares, and note the ones that declare something in `own`. */
  private async read(repoDir: string, unseen: Unseen[], own: Map<string, OwnEntries>): Promise<void> {
    for (let from = 0; from < unseen.length; ) {
      let to = from;
      let bytes = 0;
      do {
        bytes += unseen[to]!.size;
        to++;
      } while (to < unseen.length && bytes + unseen[to]!.size <= this.limits.chunkBytes);
      const chunk = unseen.slice(from, to);
      const outcomes = await catFileBatchBytes(
        this.git,
        repoDir,
        chunk.map((u) => u.objectId),
      );
      chunk.forEach((u, i) => {
        const outcome = outcomes[i];
        // The listing named this object as a file: anything else is an
        // object git could not read, and nothing is decided without it.
        if (outcome?.kind !== 'blob') throw new Error(`object ${u.objectId} could not be read`);
        const first = u.paths[0]!;
        const declared = detachEntries(
          isAccessMdPath(first)
            ? accessMdSelfEntries(outcome.bytes.toString('utf-8'))
            : parseOwnAccessEntries(frontmatterHeadOfBytes(outcome.bytes)),
        );
        this.rememberBlob(u.key, declared);
        if (declared !== null) for (const p of u.paths) own.set(p, declared);
      });
      from = to;
    }
  }

  private hold(
    commit: string,
    built: { model: M; release(): void },
    paths: readonly string[],
    own: ReadonlyMap<string, OwnEntries>,
  ): HeadMap<M> {
    const tree = this.trees.index(paths);
    // The folders of the commit: a folder declares nothing for itself (its
    // rules are its `access.md`, which the model holds), and git lists files
    // only, so they are derived from the files' paths.
    const folders = new Set<string>();
    for (const p of paths) {
      for (let cut = p.lastIndexOf('/'); cut > 0; cut = p.lastIndexOf('/', cut - 1)) {
        const folder = p.slice(0, cut);
        if (folders.has(folder)) break;
        folders.add(folder);
      }
    }
    const map: HeadMap<M> = {
      commit,
      model: built.model,
      ownEntries: (p) => own.get(p) ?? (tree.has(p) || folders.has(p) ? null : undefined),
    };
    this.trees.hold(tree);
    this.heads.set(commit, { map, tree, release: () => built.release() });
    // The map just made is the one being asked for: it is never the one dropped.
    while (
      this.heads.size > 1 &&
      (this.heads.size > this.limits.maxHeads || this.trees.heldPaths > this.limits.maxTreePaths)
    ) {
      const oldest = this.heads.entries().next().value;
      if (!oldest) break;
      this.heads.delete(oldest[0]);
      this.trees.release(oldest[1].tree);
      oldest[1].release();
    }
    return map;
  }

  /** Keep `seed` for the next start, at most every `saveEveryMs`. Nothing waits for it, and a failure costs only that start's reading. */
  private save(seed: HeadSeed): void {
    if (!this.store || this.now() - this.savedAt < this.limits.saveEveryMs) return;
    this.savedAt = this.now();
    // One after the other: a save that is slow must not land after a later
    // one and leave the older seed in the store.
    const store = this.store;
    this.saving = this.saving
      .then(() => store.save(seed))
      .catch((err: unknown) => {
        log.warn(`the access seed was not saved: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  private saving: Promise<void> = Promise.resolve();

  private rememberBlob(key: string, declared: OwnEntries | null): void {
    this.blobs.set(key, declared);
    if (this.blobs.size > this.limits.maxBlobs) {
      const oldest = this.blobs.keys().next().value;
      if (oldest !== undefined) this.blobs.delete(oldest);
    }
  }

  private rememberWithout(commit: string, until: number): void {
    this.without.set(commit, until);
    if (this.without.size > HeadMaps.WITHOUT_MAX) {
      const oldest = this.without.keys().next().value;
      if (oldest !== undefined) this.without.delete(oldest);
    }
  }
}

/** Files read from the checkout at once. */
const DISK_READS_AT_ONCE = 16;
/** A file the checkout does not hold as its version's bytes: gone, or other bytes. */
const UNVOUCHED = Symbol('unvouched');

/**
 * What the file at `relativePath` in the checkout declares for itself, read as `read` reads the version
 * `objectId` (`size` bytes), or `UNVOUCHED` when the file is not that version's bytes. The file is read to its end
 * in one pass, which hashes it as git hashes a blob and finds its frontmatter's end. Not for an `access.md`, whose
 * body decides what it declares (it goes through git).
 */
async function readDeclaredOnDisk(
  repoDir: string,
  relativePath: string,
  size: number,
  objectId: string,
): Promise<OwnEntries | null | typeof UNVOUCHED> {
  const file = path.join(repoDir, relativePath);
  let head: string;
  try {
    if ((await fs.stat(file)).size !== size) return UNVOUCHED;
    // A repository's object ids are SHA-1 (40 hex digits) or SHA-256 (64).
    const hash = createHash(objectId.length === 64 ? 'sha256' : 'sha1').update(`blob ${size}\0`);
    head = await frontmatterHeadOfWholeFile(file, (chunk) => hash.update(chunk));
    if (hash.digest('hex') !== objectId) return UNVOUCHED;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return UNVOUCHED;
    throw err;
  }
  return detachEntries(parseOwnAccessEntries(head));
}

/**
 * The same bytes say two things by name: in an `access.md` the frontmatter
 * is the folder's rules and only the body format governs the file itself;
 * anywhere else the frontmatter is the file's own. So a version is
 * remembered per reading.
 */
function blobKey(objectId: string, path: string): string {
  return `${isAccessMdPath(path) ? 'a' : 'f'}${objectId}`;
}
