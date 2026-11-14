import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { linkedAncestor } from '../no-link-below.js';

/**
 * `linkedAncestor`: the one judge of "is this path reached through a link
 * below the base". A link on the way is named; a sibling of the base that
 * merely shares its spelling is not below it and is never looked at.
 */
describe('linkedAncestor', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'no-link-below-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('answers null for a plain path below the base, and the base itself', async () => {
    const base = path.join(tmp, 'repo');
    await fs.mkdir(path.join(base, 'a', 'b'), { recursive: true });
    expect(await linkedAncestor(base, path.join(base, 'a', 'b', 'c.md'))).toBeNull();
    expect(await linkedAncestor(base, base)).toBeNull();
  });

  // Symbolic links need a privilege on Windows that a test runner does not have.
  it.skipIf(process.platform === 'win32')('names the first link on the way below the base', async () => {
    const base = path.join(tmp, 'repo');
    await fs.mkdir(path.join(base, 'real'), { recursive: true });
    await fs.symlink(path.join(base, 'real'), path.join(base, 'via'));
    expect(await linkedAncestor(base, path.join(base, 'via', 'x.md'))).toBe(path.join(base, 'via'));
  });

  it.skipIf(process.platform === 'win32')('treats a sibling that shares the base\'s spelling as outside: not below it, never walked', async () => {
    const base = path.join(tmp, 'repo');
    await fs.mkdir(base, { recursive: true });
    await fs.mkdir(path.join(tmp, 'elsewhere'));
    // `<tmp>/repository` is a LINK, and a sibling of `<tmp>/repo`: a prefix
    // match without a separator would walk it and name it as an ancestor.
    await fs.symlink(path.join(tmp, 'elsewhere'), path.join(tmp, 'repository'));
    expect(await linkedAncestor(base, path.join(tmp, 'repository', 'x.md'))).toBeNull();
  });
});
