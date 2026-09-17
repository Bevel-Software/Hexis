import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GIT_INTERNALS_MESSAGE, GitInternalsError } from '../domain-errors.js';
import { assertNotGitInternals, hasGitInternalsSegment } from '../git-internals.js';

describe('hasGitInternalsSegment', () => {
  it.each([
    '.git',
    'knowledge-base/.git',
    'knowledge-base/.git/',
    'knowledge-base/.git/config',
    '/knowledge-base/.git/HEAD',
    'knowledge-base/notes/../.git/config',
    './knowledge-base/./.git/config',
    'knowledge-base\\.git\\config',
    'knowledge-base/.GIT/config',
    'knowledge-base/.Git/config',
    'knowledge-base/%2egit/config',
    'knowledge-base/%2Egit/config',
    'knowledge-base%2F.git%2Fconfig',
    'knowledge-base/%252egit/config',
    'knowledge-base/.git./config',
    'knowledge-base/.git /config',
    'knowledge-base/sub/.git/config',
    // Twelve layers of percent-encoding: no fixed number of decoding passes lets one through.
    `knowledge-base/%${'25'.repeat(12)}2egit/config`,
  ])('names the git folder: %s', (p) => {
    expect(hasGitInternalsSegment(p)).toBe(true);
  });

  it.each([
    'knowledge-base/.github/workflows/ci.yml',
    'knowledge-base/.gitkeep',
    'knowledge-base/.gitignore',
    'knowledge-base/Knowledge/git.md',
    'knowledge-base/my.git/file',
    'knowledge-base/Notes/.git-notes.md',
    '',
  ])('leaves an ordinary path alone: %s', (p) => {
    expect(hasGitInternalsSegment(p)).toBe(false);
  });
});

describe('assertNotGitInternals — the resolved form', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-internals-'));
    await fs.mkdir(path.join(root, 'knowledge-base', '.git'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base', '.git', 'config'), '[core]\n');
    await fs.writeFile(path.join(root, 'knowledge-base', 'notes.md'), '# notes\n');
    await fs.symlink('.git', path.join(root, 'knowledge-base', 'gitlink'));
    await fs.symlink('.git/config', path.join(root, 'knowledge-base', 'cfglink'));
    await fs.symlink('gitlink', path.join(root, 'knowledge-base', 'chained'));
    // Dangling: nothing at the target yet, so a write through the link would create it inside `.git`.
    await fs.symlink('.git/hooks/post-checkout', path.join(root, 'knowledge-base', 'dangling'));
    await fs.symlink('dangling', path.join(root, 'knowledge-base', 'dangling-chained'));
    await fs.symlink('.git/no-such-dir', path.join(root, 'knowledge-base', 'dangling-dir'));
    await fs.symlink('loop-b', path.join(root, 'knowledge-base', 'loop-a'));
    await fs.symlink('loop-a', path.join(root, 'knowledge-base', 'loop-b'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(['knowledge-base/gitlink', 'knowledge-base/gitlink/config', 'knowledge-base/gitlink/new-file', 'knowledge-base/cfglink', 'knowledge-base/chained/HEAD'])(
    'refuses a link that resolves into the git folder: %s',
    async (p) => {
      const err = await assertNotGitInternals(root, p).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitInternalsError);
      expect(err).toMatchObject({ status: 403, message: GIT_INTERNALS_MESSAGE });
    },
  );

  it.each(['knowledge-base/dangling', 'knowledge-base/dangling-chained', 'knowledge-base/dangling-dir/new-file'])(
    'refuses a dangling link whose target is inside the git folder: %s',
    async (p) => {
      await expect(assertNotGitInternals(root, p)).rejects.toBeInstanceOf(GitInternalsError);
    },
  );

  it('a link loop is no refusal of its own, and does not hang', async () => {
    await expect(assertNotGitInternals(root, 'knowledge-base/loop-a')).resolves.toBeUndefined();
  });

  it('passes an ordinary path, existing or not', async () => {
    await expect(assertNotGitInternals(root, 'knowledge-base/notes.md')).resolves.toBeUndefined();
    await expect(assertNotGitInternals(root, 'knowledge-base/new/deeper.md')).resolves.toBeUndefined();
  });

  it('judges only the part below the root, so a root under some .git folder still works', async () => {
    const nested = path.join(root, 'knowledge-base', '.git', 'worktree-root');
    await fs.mkdir(path.join(nested, 'docs'), { recursive: true });
    await expect(assertNotGitInternals(nested, 'docs/a.md')).resolves.toBeUndefined();
  });
});
