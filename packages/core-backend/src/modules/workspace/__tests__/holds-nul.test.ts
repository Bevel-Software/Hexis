import { lstat, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdsNul } from '../nul-scan.js';
import { PatternTooExpensiveError, type IPatternSearch } from '../pattern-matcher.contract.js';

/**
 * The unit `grep` asks whether a named text file ripgrep answered no line from
 * is binary (`nul-scan.ts`). What a caller observes — a NUL past the first
 * chunk makes the answer "no searchable text" — is pinned through the grep
 * tool itself in `workspace.tools.test.ts`. Two properties stay here because
 * no caller can stage them: the file swapped for another, or for a link,
 * between the stat that judged it and the open that reads it is a race a tool
 * call cannot time; and a budget already spent is told apart from ripgrep's
 * own spending only by handing the unit a search whose budget is gone.
 */
let dir = '';
const free: IPatternSearch = {
  files: () => (async function* () {})(),
  list: async () => [],
  matchingLines: async (texts) => texts.map(() => []),
  charged: (work) => work(),
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holds-nul-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('holdsNul', () => {
  it('finds a NUL wherever it is, past the first chunk too, and answers false for text', async () => {
    const text = join(dir, 'text.md');
    const late = join(dir, 'late.bin');
    await writeFile(text, 'plain text\n'.repeat(20_000));
    await writeFile(late, Buffer.concat([Buffer.alloc(200 * 1024, 'x'), Buffer.from([0])]));
    expect(await holdsNul(text, await lstat(text), free)).toBe(false);
    expect(await holdsNul(late, await lstat(late), free)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('reads nothing from a file swapped in since it was judged, nor through a link', async () => {
    const p = join(dir, 'named.md');
    await writeFile(p, 'text\n');
    const judged = await lstat(p);
    // Another file holding a NUL, moved in under the judged name.
    await writeFile(join(dir, 'other'), Buffer.from([0]));
    await rename(join(dir, 'other'), p);
    expect(await holdsNul(p, judged, free)).toBe(false);
    // A link to a file holding a NUL, under the judged name.
    await writeFile(join(dir, 'outside'), Buffer.from([0]));
    await rm(p);
    await symlink(join(dir, 'outside'), p);
    expect(await holdsNul(p, judged, free)).toBe(false);
    expect(await holdsNul(p, await lstat(join(dir, 'outside')), free)).toBe(false);
  });

  it('runs under the search budget: a budget already spent answers for it', async () => {
    const p = join(dir, 'named.md');
    await writeFile(p, 'text\n');
    const spent = new PatternTooExpensiveError('needle', 5_000);
    const exhausted: IPatternSearch = { ...free, charged: () => Promise.reject(spent) };
    await expect(holdsNul(p, await lstat(p), exhausted)).rejects.toBe(spent);
  });
});
