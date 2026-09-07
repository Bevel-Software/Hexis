import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * THE rule for what a walk of the knowledge base never enters: dot-entries
 * (`.git`, `.vscode`, a parked delete) and vendored dependencies. One
 * predicate, shared by every walk that reads rules or catalogs, so that two
 * walks can never disagree about which part of the tree exists — a rename
 * that refuses on a folder the resolver would never have read is a
 * disagreement of exactly that kind.
 */
export function isSkippedEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/**
 * The ONE recursive file walk for catalog scanners: relative (`/`-separated,
 * sorted) paths of files under `root` whose basename matches. A missing root
 * yields `[]`; skipped entries (see {@link isSkippedEntry}) are never entered.
 * Scanners with different semantics (the skills scanner's stop-at-skill-folder
 * walk, the access resolver's dir chains) deliberately keep their own walks,
 * but share the skip rule.
 *
 * A directory that cannot be listed is SKIPPED by default — right for a
 * catalog, which shows what it can. A caller that must see EVERYTHING or
 * nothing (a rename rewriting every grant that names a principal) passes
 * `strict`, and the walk throws a {@link WalkError} naming the directory
 * instead: a list with a hole in it is not a list of every file, and the
 * caller can say WHICH hole rather than pass a raw errno up.
 */
export async function walkFiles(
  root: string,
  match: (basename: string) => boolean,
  opts: { strict?: boolean } = {},
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (opts.strict) throw new WalkError(rel, err);
      return;
    }
    for (const entry of entries) {
      if (isSkippedEntry(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
      else if (entry.isFile() && match(entry.name)) out.push(childRel);
    }
  };
  await walk(root, '');
  out.sort();
  return out;
}

/** A strict walk's refusal: the directory (relative to the root, `''` for the root itself) it could not list. */
export class WalkError extends Error {
  constructor(
    readonly relDir: string,
    readonly cause: unknown,
  ) {
    super(`${relDir || '.'} could not be listed — ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'WalkError';
  }
}
