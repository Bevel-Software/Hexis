import fs from 'node:fs/promises';
import path from 'node:path';
import { hasGitInternalsSegment } from '../../shared/git-internals.js';

const codeOf = (err: unknown): string | undefined => (err as { code?: string } | null)?.code;

/** The directory is not there (any more), or is no longer a directory. */
const isGone = (err: unknown): boolean => codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR';

/**
 * Recursively remove empty directories under `absoluteDir`, bottom-up, then
 * remove `absoluteDir` itself if it ends up empty. A directory is removed only
 * if it contains nothing at the moment it's visited, so any file a concurrent
 * writer dropped in mid-delete — and every parent directory on its path —
 * survives. The git folder is left alone, in any spelling of its name
 * (`shared/git-internals.ts`) — a sweep is not a way into it. Used after a recursive folder delete to
 * sweep the leftover empty-folder shells off disk so the file tree (which
 * lists on-disk directories, not just tracked files) stops showing the
 * deleted container. Only a directory that vanished or filled up under a
 * concurrent writer is passed over; any other failure (permissions, I/O) is
 * thrown, so a caller never reports a folder gone that is still there.
 */
export async function removeEmptyDirs(absoluteDir: string): Promise<void> {
  // The root itself is judged as it is on disk, a link as a link: `readdir`
  // would follow a directory link and the sweep would then empty folders
  // wherever it points — outside the workspace, for a link committed to the
  // repository. A link is never swept; the children below are `Dirent`s,
  // for which `isDirectory()` is already false on a link.
  let root: import('node:fs').Stats;
  try {
    root = await fs.lstat(absoluteDir);
  } catch (err) {
    if (isGone(err)) return;
    throw err;
  }
  if (!root.isDirectory()) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (err) {
    if (isGone(err)) return;
    throw err;
  }
  for (const entry of entries) {
    if (hasGitInternalsSegment(entry.name)) continue;
    if (entry.isDirectory()) {
      await removeEmptyDirs(path.join(absoluteDir, entry.name));
    }
  }
  // Re-read after pruning children: a subdir we just emptied now lets this
  // dir become removable too. Any surviving file (or `.git`) keeps it.
  let remaining: string[];
  try {
    remaining = await fs.readdir(absoluteDir);
  } catch (err) {
    if (isGone(err)) return;
    throw err;
  }
  if (remaining.length > 0) return;
  try {
    await fs.rmdir(absoluteDir);
  } catch (err) {
    // A concurrent writer removed it, or dropped an entry in after the scan:
    // either way the directory's fate is no longer ours to decide.
    if (isGone(err) || codeOf(err) === 'ENOTEMPTY' || codeOf(err) === 'EEXIST') return;
    throw err;
  }
}
