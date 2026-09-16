import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Recursively remove empty directories under `absoluteDir`, bottom-up, then
 * remove `absoluteDir` itself if it ends up empty. A directory is removed only
 * if it contains nothing at the moment it's visited, so any file a concurrent
 * writer dropped in mid-delete — and every parent directory on its path —
 * survives. `.git` is left alone. Used after a recursive folder delete to
 * sweep the leftover empty-folder shells off disk so the file tree (which
 * lists on-disk directories, not just tracked files) stops showing the
 * deleted container.
 */
export async function removeEmptyDirs(absoluteDir: string): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    // Already gone (raced delete) — nothing to do.
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git' && entry.isDirectory()) continue;
    if (entry.isDirectory()) {
      await removeEmptyDirs(path.join(absoluteDir, entry.name));
    }
  }
  // Re-read after pruning children: a subdir we just emptied now lets this
  // dir become removable too. Any surviving file (or `.git`) keeps it.
  const remaining = await fs.readdir(absoluteDir);
  if (remaining.length === 0) {
    await fs.rmdir(absoluteDir);
  }
}
