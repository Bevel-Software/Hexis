import type { Stats } from 'node:fs';

/**
 * The contracts for READING the disk without locks: walking a tree, honouring
 * `.bevelignore`, and probing a path. Nothing here touches the disk — the one
 * implementation is `NodeFs` in `modules/kb-fs`, wired once by the
 * composition root and injected into every module that reads the disk, so no
 * module carries a `readdir` loop, an `exists()` or an errno check of its own.
 *
 * THE directory walk ({@link ITreeWalker.walk}). Every reader of a tree — the
 * access resolver looking for rules, plugin discovery looking for manifests,
 * the explorer building its tree, the diff baseline mirroring a checkout, a
 * template seeding a repository — used to carry a recursive `readdir` loop of
 * its own, each with its own skip list, its own idea of what an unreadable
 * folder means and its own visiting order. Two loops that disagree on one of
 * those are two answers to "what is in the tree", and every such disagreement
 * was a bug. So there is one loop, and what differs between readers is SAID
 * in its {@link TreeWalkOptions}, never re-implemented:
 *
 *   - WHAT IS SKIPPED: `skip` — names that are never reported nor entered;
 *     `ignore` — whether the `.bevelignore` files on the way down are
 *     honoured; `leaf` — a folder that is reported and then left alone (a
 *     skill folder, a plugin).
 *   - IN WHAT ORDER: each folder's entries in `comparePathComponents` order
 *     (see `shared/path-order.ts`), always, so "first by path" means the same
 *     thing to every reader.
 *   - WHAT A HOLE IS: a folder that exists but could not be listed is either
 *     reported — as an event and in the result — and walked around, or the
 *     walk's own error (`unreadable: 'throw'`). Never silently skipped. A
 *     folder that vanished between listing and visiting is not a hole, and a
 *     missing root is an empty tree.
 *   - WHAT AN ENTRY IS: a file or a folder. Anything else (a symlink, a
 *     socket) is never entered and never a file — it is told to `onOther`,
 *     so a reader that must say so (or delete it) can.
 *
 * Listeners see the same events in the same order; what each makes of them
 * is its own business.
 */

/** The ignore file's own name — every reader that names it agrees on the spelling. */
export const IGNORE_FILENAME = '.bevelignore';

/** A directory entry as the walk presents it: a name and what it is. */
export interface WalkedEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * A stack of `.bevelignore` rule sets, layered like git: each file applies
 * beneath the folder it lives in, deeper files extend — and can override,
 * `!pattern` included — shallower ones. Immutable: extending returns a new
 * stack.
 */
export interface IgnoreRules {
  /**
   * The rules in force inside `dir`: these plus `dir`'s own file. No file is
   * no change. A file that is there but cannot be read is NOT — the rules
   * are unknown — and that error is the caller's (the walk makes it a hole).
   */
  extendedWith(dir: string): Promise<IgnoreRules>;
  /** Whether the entry at `absolutePath` is hidden. `isDirectory` lets `foo/`-style rules match folders only. */
  isIgnored(absolutePath: string, isDirectory: boolean): boolean;
}

/** A folder the walk is in. */
export interface WalkedDir {
  /** Repo-relative, `''` for the root. */
  rel: string;
  abs: string;
  /** Everything the folder holds — files and folders, skipped names removed, in walk order — BEFORE its ignore rules. */
  listed: readonly WalkedEntry[];
  /** The `.bevelignore` rules in force inside this folder; empty when the walk does not honour them. */
  ignore: IgnoreRules;
}

export interface TreeWalkOptions {
  /** Entries left out of every listing — never reported, never entered. Default: nothing. */
  skip?: (entry: WalkedEntry) => boolean;
  /**
   * Honour the `.bevelignore` files on the way down: each folder's rules
   * extend its parent's, and an entry a rule names is neither reported nor
   * entered (a listener can still see it in `WalkedDir.listed`). `true`
   * starts with no rules above the root; a stack starts with the rules in
   * force there. OFF by default — the explorer honours the files, the access
   * resolver must not — so every reader says which it is.
   */
  ignore?: boolean | IgnoreRules;
  /** A folder whose listing satisfies this is reported, then left alone: nothing beneath it is visited. */
  leaf?: (dir: WalkedDir, entries: readonly WalkedEntry[]) => boolean;
  /** Checked before every listing and every entry: once true, the walk ends. For a reader that stops at its first find. */
  until?: () => boolean;
  /**
   * What a folder that exists but cannot be listed is: a `'hole'` (default —
   * told to `onHole`, named in the result, walked around) or the walk's error.
   */
  unreadable?: 'hole' | 'throw';
}

export interface WalkListener {
  /** A folder was listed. `rel` is repo-relative (`''` for the root); `entries` are its children, skipped and ignored ones removed, in walk order. */
  onDir?(rel: string, entries: readonly WalkedEntry[], dir: WalkedDir): void | Promise<void>;
  /** A file was seen. `dir` is its folder (`''` for the root), `name` its basename. */
  onFile?(dir: string, name: string): void | Promise<void>;
  /** An entry that is neither a file nor a folder (a symlink, a socket) — never entered, never a file. */
  onOther?(dir: string, entry: WalkedEntry): void | Promise<void>;
  /** A folder that exists but could not be listed. */
  onHole?(rel: string, err: unknown): void | Promise<void>;
}

export interface WalkResult {
  /** Every folder that could not be listed, repo-relative (`''` for the root). */
  holes: string[];
}

/** A strict listing's refusal: the directory (relative to the root, `''` for the root itself) it could not list. */
export class WalkError extends Error {
  constructor(
    readonly relDir: string,
    readonly cause: unknown,
  ) {
    super(`${relDir || '.'} could not be listed — ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'WalkError';
  }
}

export interface ITreeWalker {
  /**
   * Walk the tree at `root`, driving every listener from one traversal.
   * A missing root is an empty tree. Listener errors propagate untouched.
   */
  walk(root: string, options: TreeWalkOptions, listeners: readonly WalkListener[]): Promise<WalkResult>;
  /**
   * The walk of a knowledge-base checkout: {@link walk} with the checkout's
   * skip list — dot-entries (`.git`, a parked delete) and vendored
   * dependencies are never seen. Nothing else is pruned by default; a reader
   * that honours `.bevelignore`, has a leaf of its own, or must stop at a
   * hole says so in `options`.
   */
  walkKb(root: string, listeners: readonly WalkListener[], options?: Omit<TreeWalkOptions, 'skip'>): Promise<WalkResult>;
  /**
   * The file listing catalog scanners want, on top of {@link walkKb}:
   * relative (`/`-separated, sorted) paths of files under `root` whose
   * basename matches. A missing root yields `[]`; skipped entries are never
   * entered. A directory that cannot be listed is SKIPPED by default — right
   * for a catalog, which shows what it can. A caller that must see
   * EVERYTHING or nothing passes `strict`, and the listing throws a
   * {@link WalkError} naming the directory instead.
   */
  walkFiles(root: string, match: (basename: string) => boolean, opts?: { strict?: boolean }): Promise<string[]>;
}

/**
 * Probing a single path. ONE definition of absence for every reader: ENOENT
 * or ENOTDIR — "there is no such path" — is the one failure a reader may
 * treat as an ordinary answer. Everything else (permissions, I/O, a loop) is
 * a failure to READ what is there, and a caller that folds it into absence
 * turns an outage into a wrong answer. Every `OrNull`/`exists` below applies
 * that rule and lets any other error out.
 */
export interface IFsProbe {
  /** Whether a filesystem error means "there is no such path". */
  isAbsence(err: unknown): boolean;
  /** Whether SOMETHING is at `p` — a link included, followed or not. */
  exists(p: string): Promise<boolean>;
  /** `stat` (links followed); null when nothing is there. */
  statOrNull(p: string): Promise<Stats | null>;
  /** `lstat` (the entry itself, a link as a link); null when nothing is there. */
  lstatOrNull(p: string): Promise<Stats | null>;
  /** Whether the entry at `p` is itself a directory (a link to one is not). */
  isDirectory(p: string): Promise<boolean>;
  /** The JSON object in the file at `p`; null when the file is absent, not JSON, or not an object. */
  readJsonObject(p: string): Promise<Record<string, unknown> | null>;
}
