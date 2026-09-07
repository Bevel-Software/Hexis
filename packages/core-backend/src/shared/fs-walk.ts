import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * The ONE recursive file walk for catalog scanners: relative (`/`-separated,
 * sorted) paths of files under `root` whose basename matches. A missing root
 * yields `[]`; dot-entries (incl. `.git`) are skipped. Scanners with different
 * semantics (the skills scanner's stop-at-skill-folder walk, the access
 * resolver's dir chains) deliberately keep their own walks.
 *
 * A directory that cannot be listed is SKIPPED by default — right for a
 * catalog, which shows what it can. A caller that must see EVERYTHING or
 * nothing (a rename rewriting every grant that names a principal) passes
 * `strict`, and the walk throws instead: a list with a hole in it is not
 * a list of every file.
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
      if (opts.strict) throw err;
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
      else if (entry.isFile() && match(entry.name)) out.push(childRel);
    }
  };
  await walk(root, '');
  out.sort();
  return out;
}
