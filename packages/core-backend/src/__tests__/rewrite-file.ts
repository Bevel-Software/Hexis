import type { LocalFilesystem } from '@mastra/core/workspace';
import { isAbsence } from '../shared/fs.contract.js';

/**
 * `LockingFilesystem.rewriteFile` on a plain `LocalFilesystem`, for suites
 * that drive the write tools over a bare disk. Every tool context the root
 * builds for a write-scoped caller holds the locking filesystem, and
 * `edit_file` calls this method unconditionally, so a suite that hands the
 * tools a bare disk must give it the method too. Same rule as the real one:
 * `rewrite` gets the file's bytes (null when nothing is there) and answers
 * what to write; a throw writes nothing. No lock: these suites run one writer.
 */
export function withRewriteFile<T extends LocalFilesystem>(fs: T): T {
  (fs as unknown as Record<string, unknown>).rewriteFile = async (
    path: string,
    rewrite: (current: Buffer | null) => string | Promise<string>,
  ) => {
    const current = await fs.readFile(path).then(
      (c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8')),
      (err: unknown) => {
        if (isAbsence(err)) return null;
        throw err;
      },
    );
    await fs.writeFile(path, await rewrite(current));
  };
  return fs;
}
