import { walkKb, isSkippedEntry } from './kb-walk.js';

export { isSkippedEntry };

/**
 * The file listing catalog scanners want, on top of {@link walkKb}: relative
 * (`/`-separated, sorted) paths of files under `root` whose basename matches.
 * A missing root yields `[]`; skipped entries are never entered.
 *
 * A directory that cannot be listed is SKIPPED by default — right for a
 * catalog, which shows what it can. A caller that must see EVERYTHING or
 * nothing passes `strict`, and the listing throws a {@link WalkError} naming
 * the directory instead: a list with a hole in it is not a list of every
 * file, and the caller can say WHICH hole rather than pass a raw errno up.
 */
export async function walkFiles(
  root: string,
  match: (basename: string) => boolean,
  opts: { strict?: boolean } = {},
): Promise<string[]> {
  const out: string[] = [];
  await walkKb(root, [
    {
      onFile(dir, name) {
        if (match(name)) out.push(dir ? `${dir}/${name}` : name);
      },
      onHole(rel, err) {
        if (opts.strict) throw new WalkError(rel, err);
      },
    },
  ]);
  out.sort();
  return out;
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
