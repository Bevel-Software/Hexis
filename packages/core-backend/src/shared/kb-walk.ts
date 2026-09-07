import path from 'node:path';
import fs from 'node:fs/promises';
import { isAbsence } from './fs-errors.js';
import { comparePathComponents } from './path-order.js';

/**
 * THE walk of a knowledge-base checkout.
 *
 * Every reader of the tree — the access resolver looking for rules, plugin
 * discovery looking for manifests, a rename looking for grants, the catalog
 * scanners — used to carry a recursive `readdir` loop of its own, each with
 * its own skip list, its own idea of what an unreadable folder means and its
 * own visiting order. Two loops that disagree on one of those are two
 * answers to "what is in the tree", and every such disagreement was a bug.
 *
 * So there is one loop, and it decides three things once:
 *
 *   - WHAT IS SKIPPED: {@link isSkippedEntry} — dot-entries (`.git`, a parked
 *     delete) and vendored dependencies. Nothing else is pruned; a listener
 *     that stops at a leaf of its own (a skill folder, a plugin folder)
 *     simply ignores what lies beneath it.
 *   - IN WHAT ORDER: each folder's entries in {@link comparePathComponents}
 *     order, so "first by path" means the same thing to every listener.
 *   - WHAT A HOLE IS: a folder that exists but could not be listed is
 *     reported as an event and in the result — never thrown, never silently
 *     skipped — so a reader can show what it saw and a writer can refuse.
 *     A folder that vanished between listing and visiting is not a hole.
 *
 * Listeners see the same events in the same order; what each makes of them
 * is its own business (`.bevelignore` included — the explorer honours it,
 * the resolver must not, so it is a listener's decision, not the walk's).
 */
export function isSkippedEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** A directory entry as the walk presents it: a name and what it is. */
export interface WalkedEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface KbWalkListener {
  /** A folder was listed. `rel` is repo-relative (`''` for the root); `entries` are its children, skipped ones removed, in walk order. */
  onDir?(rel: string, entries: readonly WalkedEntry[]): void | Promise<void>;
  /** A file was seen. `dir` is its folder (`''` for the root), `name` its basename. */
  onFile?(dir: string, name: string): void | Promise<void>;
  /** A folder that exists but could not be listed. */
  onHole?(rel: string, err: unknown): void | Promise<void>;
}

export interface KbWalkResult {
  /** Every folder that could not be listed, repo-relative (`''` for the root). */
  holes: string[];
}

/**
 * Walk the checkout at `root`, driving every listener from one traversal.
 * A missing root is an empty tree. Listener errors propagate untouched.
 */
export async function walkKb(root: string, listeners: readonly KbWalkListener[]): Promise<KbWalkResult> {
  const holes: string[] = [];

  const visit = async (abs: string, rel: string): Promise<void> => {
    let listed: import('node:fs').Dirent[];
    try {
      listed = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (isAbsence(err)) {
        // The root: a checkout without this tree, an empty walk. Deeper: a
        // folder that vanished between listing and visiting — not a hole.
        return;
      }
      holes.push(rel);
      for (const l of listeners) await l.onHole?.(rel, err);
      return;
    }
    const entries: WalkedEntry[] = listed
      .filter((e) => !isSkippedEntry(e.name) && (e.isDirectory() || e.isFile()))
      .sort((a, b) => comparePathComponents(a.name, b.name));
    for (const l of listeners) await l.onDir?.(rel, entries);
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(path.join(abs, entry.name), childRel);
      } else {
        for (const l of listeners) await l.onFile?.(rel, entry.name);
      }
    }
  };

  await visit(root, '');
  return { holes };
}
