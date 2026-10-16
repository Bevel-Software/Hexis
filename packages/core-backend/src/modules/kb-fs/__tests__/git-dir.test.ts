import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { gitDirOf, readGitfile } from '../git-dir.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  return stdout.trim();
}

/**
 * The one resolver of a checkout's git directory, checked against what git
 * itself answers (`rev-parse --absolute-git-dir`) for a clone and a worktree.
 */
describe('gitDirOf', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'git-dir-')));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('is the .git folder of a clone and the folder a worktree .git file names, as git says', async () => {
    const clone = path.join(root, 'clone');
    await fs.mkdir(clone);
    await git(clone, 'init', '-q');
    await git(clone, '-c', 'user.name=T', '-c', 'user.email=t@x.com', 'commit', '-q', '--allow-empty', '-m', 'c');
    const worktree = path.join(root, 'wt');
    await git(clone, 'worktree', 'add', '-q', '-b', 'side', worktree);

    for (const dir of [clone, worktree]) {
      const fromGit = path.resolve(await git(dir, 'rev-parse', '--absolute-git-dir'));
      expect(path.resolve((await gitDirOf(dir))!)).toBe(await fs.realpath(fromGit));
    }
  });

  it('is null with no .git, and with a .git file that names no folder', async () => {
    expect(await gitDirOf(root)).toBeNull();
    await fs.writeFile(path.join(root, '.git'), 'not a gitfile\n');
    expect(await gitDirOf(root)).toBeNull();
  });

  it('resolves a relative gitdir against the file’s own folder', async () => {
    await fs.writeFile(path.join(root, '.git'), 'gitdir: ../elsewhere/wt\n');
    expect(await readGitfile(path.join(root, '.git'))).toBe(path.resolve(root, '../elsewhere/wt'));
    expect(await gitDirOf(root)).toBe(path.resolve(root, '../elsewhere/wt'));
  });
});
