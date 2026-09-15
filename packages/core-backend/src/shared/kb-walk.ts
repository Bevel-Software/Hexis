import path from 'node:path';
import fs from 'node:fs/promises';
import { isAbsence } from './fs-errors.js';
import { comparePathComponents } from './path-order.js';
import { BevelIgnoreStack } from './bevel-ignore.js';

/**
 * THE directory walk.
 *
 * Every reader of a tree — the access resolver looking for rules, plugin
 * discovery looking for manifests, the explorer building its tree, the diff
 * baseline mirroring a checkout, a template seeding a repository — used to
 * carry a recursive `readdir` loop of its own, each with its own skip list,
 * its own idea of what an unreadable folder means and its own visiting
 * order. Two loops that disagree on one of those are two answers to "what is
 * in the tree", and every such disagreement was a bug.
 *
 * So there is one loop, {@link walkTree}. What differs between readers is
 * SAID in its {@link TreeWalkOptions}, never re-implemented:
 *
 *   - WHAT IS SKIPPED: `skip` — names that are never reported nor entered;
 *     `ignore` — whether the `.bevelignore` files on the way down are
 *     honoured; `leaf` — a folder that is reported and then left alone (a
 *     skill folder, a plugin).
 *   - IN WHAT ORDER: each folder's entries in {@link comparePathComponents}
 *     order, always, so "first by path" means the same thing to every reader.
 *   - WHAT A HOLE IS: a folder that exists but could not be listed is either
 *     reported — as an event and in the result — and walked around, or the
 *     walk's own error (`unreadable: 'throw'`). Never silently skipped. A
 *     folder that vanished between listing and visiting is not a hole, and a
 *     missing root is an empty tree.
 *   - WHAT AN ENTRY IS: a file or a folder. Anything else (a symlink, a
 *     socket) is never entered and never a file — it is told to `onOther`,
 *     so a reader that must say so (or delete it) can.
 *
 * {@link walkKb} is the walk of a knowledge-base checkout: this loop with the
 * checkout's skip list, {@link isSkippedEntry}. Listeners see the same events
 * in the same order; what each makes of them is its own business.
 */
export function isSkippedEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** A directory entry as the walk presents it: a name and what it is. */
export interface WalkedEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** A folder the walk is in. */
export interface WalkedDir {
  /** Repo-relative, `''` for the root. */
  rel: string;
  abs: string;
  /** Everything the folder holds — files and folders, skipped names removed, in walk order — BEFORE its ignore rules. */
  listed: readonly WalkedEntry[];
  /** The `.bevelignore` rules in force inside this folder; empty when the walk does not honour them. */
  ignore: BevelIgnoreStack;
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
  ignore?: boolean | BevelIgnoreStack;
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

export interface KbWalkListener {
  /** A folder was listed. `rel` is repo-relative (`''` for the root); `entries` are its children, skipped and ignored ones removed, in walk order. */
  onDir?(rel: string, entries: readonly WalkedEntry[], dir: WalkedDir): void | Promise<void>;
  /** A file was seen. `dir` is its folder (`''` for the root), `name` its basename. */
  onFile?(dir: string, name: string): void | Promise<void>;
  /** An entry that is neither a file nor a folder (a symlink, a socket) — never entered, never a file. */
  onOther?(dir: string, entry: WalkedEntry): void | Promise<void>;
  /** A folder that exists but could not be listed. */
  onHole?(rel: string, err: unknown): void | Promise<void>;
}

export interface KbWalkResult {
  /** Every folder that could not be listed, repo-relative (`''` for the root). */
  holes: string[];
}

/**
 * Walk the tree at `root`, driving every listener from one traversal.
 * A missing root is an empty tree. Listener errors propagate untouched.
 */
export async function walkTree(
  root: string,
  options: TreeWalkOptions,
  listeners: readonly KbWalkListener[],
): Promise<KbWalkResult> {
  const { skip, ignore = false, leaf, until, unreadable = 'hole' } = options;
  const holes: string[] = [];

  const visit = async (abs: string, rel: string, inherited: BevelIgnoreStack): Promise<void> => {
    if (until?.()) return;
    let raw: import('node:fs').Dirent[];
    let rules: BevelIgnoreStack;
    try {
      raw = await fs.readdir(abs, { withFileTypes: true });
      // A folder whose own `.bevelignore` is there but cannot be read is as
      // much a hole as one that cannot be listed: its rules are unknown, so
      // nothing in it can be judged. (No file is no rules, never an error.)
      rules = ignore ? await inherited.extendedWith(abs) : inherited;
    } catch (err) {
      if (isAbsence(err)) {
        // The root: a checkout without this tree, an empty walk. Deeper: a
        // folder that vanished between listing and visiting — not a hole.
        return;
      }
      if (unreadable === 'throw') throw err;
      holes.push(rel);
      for (const l of listeners) await l.onHole?.(rel, err);
      return;
    }
    const seen = raw.filter((e) => !skip?.(e)).sort((a, b) => comparePathComponents(a.name, b.name));
    const isEntry = (e: WalkedEntry) => e.isDirectory() || e.isFile();
    const listed = seen.filter(isEntry);
    // The rules apply to everything that is there — a link a rule names is as hidden as a file.
    const visible = ignore ? seen.filter((e) => !rules.isIgnored(path.join(abs, e.name), e.isDirectory())) : seen;
    const entries = visible.filter(isEntry);
    const dir: WalkedDir = { rel, abs, listed, ignore: rules };
    for (const l of listeners) await l.onDir?.(rel, entries, dir);
    if (leaf?.(dir, entries)) return;
    for (const entry of visible) {
      if (until?.()) return;
      if (!isEntry(entry)) {
        for (const l of listeners) await l.onOther?.(rel, entry);
      } else if (entry.isDirectory()) {
        await visit(path.join(abs, entry.name), rel ? `${rel}/${entry.name}` : entry.name, rules);
      } else {
        for (const l of listeners) await l.onFile?.(rel, entry.name);
      }
    }
  };

  await visit(root, '', ignore instanceof BevelIgnoreStack ? ignore : BevelIgnoreStack.empty());
  return { holes };
}

/**
 * The walk of a knowledge-base checkout: {@link walkTree} with the checkout's
 * skip list — dot-entries (`.git`, a parked delete) and vendored dependencies
 * are never seen. Nothing else is pruned by default; a reader that honours
 * `.bevelignore`, has a leaf of its own, or must stop at a hole says so in
 * `options`.
 */
export async function walkKb(
  root: string,
  listeners: readonly KbWalkListener[],
  options: Omit<TreeWalkOptions, 'skip'> = {},
): Promise<KbWalkResult> {
  return walkTree(root, { ...options, skip: (e) => isSkippedEntry(e.name) }, listeners);
}
