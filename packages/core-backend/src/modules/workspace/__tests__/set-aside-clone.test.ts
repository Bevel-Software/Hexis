import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setAsideClone } from '../set-aside-clone.js';

/**
 * Setting a working copy aside is the one thing between a replaced repository
 * and the loss of whatever was only ever committed in that copy. So the
 * destination is never somebody else's: a folder already there holds an
 * EARLIER set-aside, and this one must neither land in it nor clean it up.
 */

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'set-aside-clone-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function folderWith(name: string, file: string, content: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), content, 'utf8');
  return dir;
}

describe('setAsideClone', () => {
  it('moves the working copy, whole, to a destination that is not there yet', async () => {
    const copy = await folderWith('workspaces/main/knowledge-base', 'unpushed.md', 'local work');
    const dest = path.join(root, 'replaced-working-copies', 'stamp', 'main');

    await setAsideClone(copy, dest);

    expect(await fs.readFile(path.join(dest, 'unpushed.md'), 'utf8')).toBe('local work');
    expect(await fs.access(copy).then(() => true, () => false)).toBe(false);
  });

  it('refuses a destination that already holds a set-aside copy, and touches neither', async () => {
    const copy = await folderWith('workspaces/main/knowledge-base', 'unpushed.md', 'this copy');
    const dest = await folderWith('replaced-working-copies/stamp/main', 'unpushed.md', 'an earlier copy');

    await expect(setAsideClone(copy, dest)).rejects.toThrow(/already holds one/);

    // The earlier one is whole, and so is the one that was to be moved.
    expect(await fs.readFile(path.join(dest, 'unpushed.md'), 'utf8')).toBe('an earlier copy');
    expect(await fs.readFile(path.join(copy, 'unpushed.md'), 'utf8')).toBe('this copy');
  });
});
