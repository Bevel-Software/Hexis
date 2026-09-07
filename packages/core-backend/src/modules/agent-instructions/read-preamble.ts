import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { PREAMBLE_FILE } from './compose.js';

/** The one reader both the hosted proxy and the agent-facing route call. */
export type AgentPreambleReader = () => Promise<string | null>;

/** The two workspace operations the reader needs, so a test can stand in for the service. */
export type PreambleWorkspace = Pick<WorkspaceService, 'getOrCreateForBranch' | 'getWorkspacePath'>;

/**
 * The raw content of `mcp-description.md` on the default branch, read with
 * PLATFORM privileges: the root is default-deny for reads, and the preamble is
 * a broadcast the admin writes for every connected agent, so it is never read
 * as the caller. `null` only for an ABSENT file (ENOENT); any other failure
 * throws, so a disk fault never masquerades as "no preamble". The workspace is
 * created first when it does not exist yet, exactly as the plugin archive
 * route does.
 *
 * SYMLINKS ARE REFUSED, the same rule the plugin archive applies. This file is
 * read as the platform and sent to every agent, so a link at this name (they
 * only arrive by direct git push; the platform's own write paths never create
 * one) would broadcast whatever the server process can read. `lstat` rejects a
 * link or any non-regular entry before the open, and the open itself uses
 * `O_NOFOLLOW` and reads through the handle it checked, so the bytes sent come
 * from the inode the check passed rather than from a path swapped in between.
 *
 * Inside the workspace the repository is the `<kbDirName>/` folder, so the
 * path is `<kbDirName>/mcp-description.md`, the same shape `SkillService` and
 * the archive route use.
 */
export async function readAgentPreamble(workspace: PreambleWorkspace, kbDirName: string): Promise<string | null> {
  await workspace.getOrCreateForBranch(DEFAULT_BRANCH);
  const wsDir = await workspace.getWorkspacePath(workspaceIdForBranch(DEFAULT_BRANCH));
  const abs = path.join(wsDir, kbDirName, PREAMBLE_FILE);

  const found = await fs.lstat(abs).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (found === null) return null;
  if (!found.isFile()) throw notRegular(found.isSymbolicLink() ? 'symlink' : found.isDirectory() ? 'directory' : 'special file');

  const handle = await fs
    .open(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null; // deleted since the lstat: an absence, not a failure
      if (err.code === 'ELOOP') throw notRegular('symlink'); // O_NOFOLLOW's spelling of "the final component is a link"
      throw err;
    });
  if (handle === null) return null;
  try {
    if (!(await handle.stat()).isFile()) throw notRegular('special file');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function notRegular(kind: string): Error {
  return new Error(
    `${PREAMBLE_FILE} on branch "${DEFAULT_BRANCH}" is a ${kind}, not a regular file; ` +
      'refusing to read it. Replace it with a plain markdown file.',
  );
}
