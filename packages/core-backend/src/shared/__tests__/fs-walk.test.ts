import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { walkFiles } from '../fs-walk.js';

describe('walkFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-walk-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns [] for a missing root', async () => {
    expect(await walkFiles(path.join(root, 'nope'), () => true)).toEqual([]);
  });

  it('walks nested directories, filters by basename, and sorts the result', async () => {
    await fs.mkdir(path.join(root, 'b/deep'), { recursive: true });
    await fs.mkdir(path.join(root, 'a'), { recursive: true });
    await fs.writeFile(path.join(root, 'b/deep/z.tool'), '');
    await fs.writeFile(path.join(root, 'a/y.tool'), '');
    await fs.writeFile(path.join(root, 'a/skip.md'), '');
    await fs.writeFile(path.join(root, 'x.tool'), '');

    const found = await walkFiles(root, (n) => n.endsWith('.tool'));
    // Relative `/`-separated paths, sorted, only matching basenames.
    expect(found).toEqual(['a/y.tool', 'b/deep/z.tool', 'x.tool']);
  });

  it('skips dot-prefixed entries — files AND whole directories (.git)', async () => {
    await fs.mkdir(path.join(root, '.git/objects'), { recursive: true });
    await fs.writeFile(path.join(root, '.git/objects/a.tool'), '');
    await fs.writeFile(path.join(root, '.hidden.tool'), '');
    await fs.writeFile(path.join(root, 'visible.tool'), '');

    expect(await walkFiles(root, (n) => n.endsWith('.tool'))).toEqual(['visible.tool']);
  });
});
