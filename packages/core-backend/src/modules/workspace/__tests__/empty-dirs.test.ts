import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeEmptyDirs } from '../empty-dirs.js';

/**
 * The sweep after a folder delete takes empty folder shells off disk — and
 * only shells under the folder it was given, on the disk it was given: a
 * link standing where that folder is points elsewhere, and elsewhere is not
 * swept.
 */
describe('removeEmptyDirs', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-empty-dirs-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('removes the empty shells bottom-up and keeps a folder that still holds a file', async () => {
    await fs.mkdir(path.join(root, 'ws', 'a', 'b', 'c'), { recursive: true });
    await fs.mkdir(path.join(root, 'ws', 'a', 'kept'), { recursive: true });
    await fs.writeFile(path.join(root, 'ws', 'a', 'kept', 'file.md'), 'x');
    await removeEmptyDirs(path.join(root, 'ws', 'a'));
    await expect(fs.stat(path.join(root, 'ws', 'a', 'b'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(root, 'ws', 'a', 'kept', 'file.md'))).resolves.toBeDefined();
  });

  it('never follows a link: a linked folder root sweeps nothing where it points', async () => {
    await fs.mkdir(path.join(root, 'outside', 'empty'), { recursive: true });
    await fs.mkdir(path.join(root, 'ws'), { recursive: true });
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'ws', 'linked'), 'dir');
    await removeEmptyDirs(path.join(root, 'ws', 'linked'));
    await expect(fs.stat(path.join(root, 'outside', 'empty'))).resolves.toBeDefined();
    await expect(fs.lstat(path.join(root, 'ws', 'linked'))).resolves.toBeDefined();
    // Nor a link met on the way down.
    await fs.mkdir(path.join(root, 'ws', 'a'), { recursive: true });
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'ws', 'a', 'linked'), 'dir');
    await removeEmptyDirs(path.join(root, 'ws', 'a'));
    await expect(fs.stat(path.join(root, 'outside', 'empty'))).resolves.toBeDefined();
  });
});
