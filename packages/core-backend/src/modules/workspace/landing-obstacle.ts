import path from 'node:path';
import { assertNotGitInternals } from '../../shared/git-internals.js';
import { GitInternalsError } from '../../shared/domain-errors.js';
import { linkedAncestor } from '../../shared/no-link-below.js';

/**
 * What stops bytes from landing at a workspace path, read from what is on disk
 * at and above it: a symbolic link on the way inside the repository (`link`,
 * the workspace path of the first one), or the repository's git folder, which
 * the path names or resolves into (`git-internals`).
 */
export type LandingObstacle = { kind: 'link'; link: string } | { kind: 'git-internals' };

/**
 * The ONE check of a landing target both archive doors ask: `unzipFile` and
 * `apply_file_upload`, each in the `check` it hands `LockingFilesystem.writeFiles`.
 * Its answer depends on what is on disk at and above the target, so it tells
 * whoever reads it what lies in the target's folders: it is asked only with
 * the target's lock held, after the lock's own write rule and read-before-write
 * have let the path through. Null when nothing stands in the way.
 */
export async function landingObstacle(
  workspaceDir: string,
  kbDirName: string,
  wsPath: string,
): Promise<LandingObstacle | null> {
  const absolute = path.resolve(workspaceDir, wsPath);
  try {
    await assertNotGitInternals(workspaceDir, wsPath, absolute);
  } catch (err) {
    if (err instanceof GitInternalsError) return { kind: 'git-internals' };
    throw err;
  }
  const link = await linkedAncestor(path.join(workspaceDir, kbDirName), absolute);
  return link === null ? null : { kind: 'link', link: path.relative(workspaceDir, link).replace(/\\/g, '/') };
}
