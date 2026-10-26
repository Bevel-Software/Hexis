import { constants as fsConstants, type Stats } from 'node:fs';
import nodeFs from 'node:fs/promises';
import type { IPatternSearch } from './pattern-matcher.contract.js';

/** How much of a file {@link holdsNul} holds in memory at once. */
export const NUL_SCAN_CHUNK = 64 * 1024;

/**
 * Whether the file at `absolute` holds a NUL, read a chunk at a time and
 * stopped at the first, under the search's budget: a check that outlives it
 * is answered as the search is, and reads no further. The file is opened
 * without following a link, and only the file that was judged (`judged`, its
 * device and inode) is read: a link or another file swapped in since, here or
 * in a folder above it, is not, and holds nothing.
 *
 * The check a named text file gets from `grep` when ripgrep answers no line
 * from it (see `workspace.tools.ts`, `grepTextFile`): ripgrep stops reading a
 * file at the lines the answer can take, so a NUL past them goes unseen by it,
 * and "no searchable text" must be told from "no match" by this read.
 */
export async function holdsNul(absolute: string, judged: Stats, search: IPatternSearch): Promise<boolean> {
  let stopped = false;
  try {
    return await search.charged(async () => {
      let handle: nodeFs.FileHandle;
      try {
        handle = await nodeFs.open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      } catch (err) {
        // ELOOP: the name is a link now. Anything else is the caller's to answer.
        if ((err as { code?: unknown } | null)?.code === 'ELOOP') return false;
        throw err;
      }
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== judged.dev || opened.ino !== judged.ino) return false;
        const chunk = Buffer.alloc(NUL_SCAN_CHUNK);
        while (!stopped) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) return false;
          if (chunk.subarray(0, bytesRead).includes(0)) return true;
        }
        return false;
      } finally {
        await handle.close();
      }
    });
  } finally {
    stopped = true;
  }
}
