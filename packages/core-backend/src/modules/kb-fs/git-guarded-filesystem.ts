import path from 'node:path';
import {
  LocalFilesystem,
  type CopyOptions,
  type FileContent,
  type FileEntry,
  type FileStat,
  type ListOptions,
  type ReadOptions,
  type RemoveOptions,
  type WriteOptions,
} from '@mastra/core/workspace';
import { GitInternalsError } from '../../shared/domain-errors.js';
import { assertNotGitInternals, hasGitInternalsSegment } from '../../shared/git-internals.js';

/**
 * A `LocalFilesystem` on which the repository's git folder does not exist.
 *
 * Every agent filesystem — the lock-aware writer and the read-only one —
 * extends this, so each method a file tool reaches refuses a path that names
 * the folder or resolves into it (see `shared/git-internals.ts`) before it
 * does anything else, and a listing leaves the folder, and any link into it,
 * out. The workspace tools check their path inputs up front as well; this is
 * the floor under them, for whatever reaches the filesystem another way.
 */
export class GitGuardedFilesystem extends LocalFilesystem {
  /**
   * Refuse `inputPath` when it names the git folder or resolves into it.
   *
   * The caller's SPELLING is judged first, every way it could land: this
   * filesystem's own resolver reads a backslash as an ordinary character and
   * carries a leading climb out of the workspace, so a link reached either way
   * used to resolve to nothing and pass. Where this filesystem would actually
   * put the path is then judged too, when that is somewhere else again.
   */
  async assertNotGitInternals(inputPath: string): Promise<void> {
    // ONE call. Given the place this filesystem would put the path, the rule
    // judges every spelling of the caller's own string lexically and probes
    // the disk once, for that place; calling it first WITHOUT the place made
    // it probe every candidate spelling as well — two to four realpath walks
    // per read on top of the one that matters. Only a path this filesystem
    // cannot place at all is judged on its spellings alone.
    await assertNotGitInternals(this.basePath, inputPath, this.resolveAbsolutePath(inputPath));
  }

  override async readFile(inputPath: string, options?: ReadOptions): Promise<string | Buffer> {
    await this.assertNotGitInternals(inputPath);
    return super.readFile(inputPath, options);
  }

  override async writeFile(inputPath: string, content: FileContent, options?: WriteOptions): Promise<void> {
    await this.assertNotGitInternals(inputPath);
    return super.writeFile(inputPath, content, options);
  }

  override async appendFile(inputPath: string, content: FileContent): Promise<void> {
    await this.assertNotGitInternals(inputPath);
    return super.appendFile(inputPath, content);
  }

  override async deleteFile(inputPath: string, options?: RemoveOptions): Promise<void> {
    await this.assertNotGitInternals(inputPath);
    return super.deleteFile(inputPath, options);
  }

  override async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.assertNotGitInternals(src);
    await this.assertNotGitInternals(dest);
    return super.copyFile(src, dest, options);
  }

  override async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.assertNotGitInternals(src);
    await this.assertNotGitInternals(dest);
    return super.moveFile(src, dest, options);
  }

  override async mkdir(inputPath: string, options?: { recursive?: boolean }): Promise<void> {
    await this.assertNotGitInternals(inputPath);
    return super.mkdir(inputPath, options);
  }

  override async rmdir(inputPath: string, options?: RemoveOptions): Promise<void> {
    await this.assertNotGitInternals(inputPath);
    return super.rmdir(inputPath, options);
  }

  /**
   * The recursion is done HERE, not in `LocalFilesystem`: its recursive walk
   * calls back into this override for every child directory, and the git
   * folder would refuse the whole listing instead of being left out of it.
   * Same order and naming as the base (each directory followed by its
   * `dir/child` entries), with the git folder and links into it filtered first.
   */
  override async readdir(inputPath: string, options?: ListOptions): Promise<FileEntry[]> {
    await this.assertNotGitInternals(inputPath);
    const { recursive, maxDepth, ...flat } = options ?? {};
    const entries = await super.readdir(inputPath, flat);
    const dir = inputPath.replace(/\\/g, '/');
    const visible: FileEntry[] = [];
    for (const entry of entries) {
      if (hasGitInternalsSegment(entry.name)) continue;
      const childPath = path.posix.join(dir, entry.name);
      if (entry.isSymlink) {
        try {
          await this.assertNotGitInternals(childPath);
        } catch (err) {
          if (err instanceof GitInternalsError) continue;
          throw err;
        }
      }
      visible.push(entry);
      const depth = maxDepth ?? 100;
      if (recursive && entry.type === 'directory' && depth > 0) {
        const children = await this.readdir(childPath, { ...options, maxDepth: depth - 1 });
        visible.push(...children.map((child) => ({ ...child, name: `${entry.name}/${child.name}` })));
      }
    }
    return visible;
  }

  override async exists(inputPath: string): Promise<boolean> {
    await this.assertNotGitInternals(inputPath);
    return super.exists(inputPath);
  }

  override async stat(inputPath: string): Promise<FileStat> {
    await this.assertNotGitInternals(inputPath);
    return super.stat(inputPath);
  }

  override async realpath(inputPath: string): Promise<string> {
    await this.assertNotGitInternals(inputPath);
    return super.realpath(inputPath);
  }
}
