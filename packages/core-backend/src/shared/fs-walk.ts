import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * The ONE recursive file walk for catalog scanners: relative (`/`-separated,
 * sorted) paths of files under `root` whose basename matches. A missing root
 * yields `[]`; dot-entries (incl. `.git`) are skipped. Scanners with different
 * semantics (the skills scanner's stop-at-skill-folder walk, the access
 * resolver's dir chains) deliberately keep their own walks.
 */
export async function walkFiles(root: string, match: (basename: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
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
