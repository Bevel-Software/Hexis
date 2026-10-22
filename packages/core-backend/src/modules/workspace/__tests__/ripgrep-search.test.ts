import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareSearchPaths,
  RipgrepPatternMatcher,
  type FileMatches,
  type IPatternSearch,
  type RipgrepPatternMatcherOptions,
  type TreeSearchOptions,
} from '../index.js';
import { slowRipgrep } from '../../../__tests__/slow-ripgrep.js';

/**
 * The ripgrep runner through its contract, against the real `rg` on PATH:
 * what a walk covers and in which order, how its JSON is read, how a pattern
 * the engine refuses is answered, and that every run ends — at the budget, on
 * an early stop, when the caller goes away, or on `close()`.
 */
let dir = '';
let matchers: RipgrepPatternMatcher[] = [];

function matcher(opts?: RipgrepPatternMatcherOptions): RipgrepPatternMatcher {
  const m = new RipgrepPatternMatcher(opts);
  matchers.push(m);
  return m;
}

const search = (pattern: string, opts?: RipgrepPatternMatcherOptions, ignoreCase = false): Promise<IPatternSearch> =>
  matcher(opts).search(pattern, { ignoreCase });

async function all(
  s: IPatternSearch,
  exclude: string[] = [],
  opts: Partial<TreeSearchOptions> & { root?: string } = {},
): Promise<FileMatches[]> {
  const out: FileMatches[] = [];
  const { root = 'kb', ...rest } = opts;
  const cwd = root === '.' ? join(dir, 'kb') : dir;
  for await (const f of s.files({ cwd, root }, { excludeExtensions: exclude, excludePaths: [], maxLinesPerFile: 1_000, ...rest })) {
    out.push(f);
  }
  return out;
}

async function put(rel: string, content: string | Buffer): Promise<void> {
  const p = join(dir, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, content);
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'rg-search-')));
});
afterEach(async () => {
  await Promise.all(matchers.map((m) => m.close()));
  matchers = [];
  await rm(dir, { recursive: true, force: true });
});

describe('RipgrepPatternMatcher', () => {
  it('walks in path order, segment by segment, and reads each file\'s lines as ripgrep printed them', async () => {
    await put('kb/b.md', 'x\nneedle b\r\n');
    await put('kb/a/z.md', 'needle z\n');
    await put('kb/a.md', 'needle a\n');
    await put('kb/with space/ü.md', 'needle ü\n');
    const files = await all(await search('needle'));
    expect(files).toEqual([
      { path: 'a/z.md', lines: [{ line: 1, text: 'needle z' }] },
      { path: 'a.md', lines: [{ line: 1, text: 'needle a' }] },
      // A CRLF line keeps its `\r`, as `split('\n')` of the file would.
      { path: 'b.md', lines: [{ line: 2, text: 'needle b\r' }] },
      { path: 'with space/ü.md', lines: [{ line: 1, text: 'needle ü' }] },
    ]);
    const paths = files.map((f) => f.path);
    expect([...paths].sort(compareSearchPaths)).toEqual(paths);
  });

  it('leaves out binary files, lines that are not UTF-8, excluded extensions and .git in any case', async () => {
    await put('kb/bin.dat', Buffer.concat([Buffer.from('needle\n'), Buffer.from([0])]));
    // NUL far past the first buffer: what ripgrep matched before it is dropped too.
    await put('kb/late-bin.dat', Buffer.concat([Buffer.from('needle\n'), Buffer.alloc(200_000, 'x'), Buffer.from([0])]));
    await put('kb/latin.txt', Buffer.concat([Buffer.from('needle \xff\n', 'latin1'), Buffer.from('needle ok\n')]));
    await put('kb/doc.DOCX', 'needle\n');
    await put('kb/.git/x', 'needle\n');
    await put('kb/sub/.Git/x', 'needle\n');
    const files = await all(await search('needle'), ['.docx']);
    expect(files).toEqual([{ path: 'latin.txt', lines: [{ line: 2, text: 'needle ok' }] }]);
  });

  it('reads a match on one very long line whole, however many chunks its record spans', async () => {
    const long = `needle ${'é'.repeat(3_000_000)} end`;
    await put('kb/minified.json', `${long}\nneedle short\n`);
    const files = await all(await search('needle'));
    expect(files).toHaveLength(1);
    expect(files[0]!.lines).toHaveLength(2);
    expect(files[0]!.lines[0]!.text === long).toBe(true);
    expect(files[0]!.lines[1]).toEqual({ line: 2, text: 'needle short' });
  });

  it('lists every file by the same walk, in the same order, outside .git and never through a link', async () => {
    await put('kb/b.pdf', 'x');
    await put('kb/a/One.PDF', 'x');
    await put('kb/c.md', 'x');
    await put('kb/.git/d.pdf', 'x');
    await put('kb/.hidden/e.eml', 'x');
    await symlink(join(dir, 'kb/c.md'), join(dir, 'kb/link.md'));
    const s = await search('x');
    expect(await s.list({ cwd: dir, root: 'kb' })).toEqual(['.hidden/e.eml', 'a/One.PDF', 'b.pdf', 'c.md']);
  });

  it('never answers an excluded file, whatever its name, from any root, and still answers its siblings', async () => {
    const names = ['secret.md', 'we ird[1]/#c*.md', '!d.md', 'e.md ', '{f,g}.md', 'back\\slash.md', 'q?.md'];
    for (const n of names) await put(`kb/${n}`, 'needle\n');
    await put('kb/open.md', 'needle\n');
    await put('kb/qx.md', 'needle\n');
    for (const root of ['kb', '.']) {
      const files = await all(await search('needle'), [], { root, excludePaths: names });
      expect(files.map((f) => f.path), root).toEqual(['open.md', 'qx.md']);
    }
  });

  it('keeps at most maxLinesPerFile lines of a file and still answers the next file', async () => {
    await put('kb/a.md', 'needle\n'.repeat(10));
    await put('kb/b.md', 'x\nneedle b\n');
    const files = await all(await search('needle'), [], { maxLinesPerFile: 3 });
    expect(files).toEqual([
      { path: 'a.md', lines: [1, 2, 3].map((line) => ({ line, text: 'needle' })) },
      { path: 'b.md', lines: [{ line: 2, text: 'needle b' }] },
    ]);
  });

  it('places each matching line in the text it came from', async () => {
    const s = await search('^n');
    expect(await s.matchingLines(['no\nyes\nnah', '', 'x\n', 'n'])).toEqual([[0, 2], [], [], [0]]);
    expect(await s.matchingLines([])).toEqual([]);
    // An empty last line is a line, as `split('\n')` has it.
    expect(await (await search('^$')).matchingLines(['a\n'])).toEqual([[1]]);
  });

  it('honours ignoreCase', async () => {
    expect(await (await search('NEEDLE')).matchingLines(['needle'])).toEqual([[]]);
    expect(await (await search('NEEDLE', {}, true)).matchingLines(['needle'])).toEqual([[0]]);
  });

  it('refuses what the engine refuses, quoting its reason without its advice to pass flags', async () => {
    await expect(search('foo(?=bar)')).rejects.toMatchObject({ status: 400, details: { code: 'invalid_pattern' } });
    const err = (await search('(a)\\1').catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^Invalid regex: regex parse error:/);
    expect(err.message).toContain('backreferences are not supported');
    expect(err.message).not.toContain('PCRE2');
    expect(err.message).toContain("grep runs ripgrep's default regex engine");
    await expect(search('a\u0000b')).rejects.toMatchObject({ status: 400 });
    await expect(search('x'.repeat(1_001))).rejects.toMatchObject({ status: 400, details: { code: 'pattern_too_long' } });
  });

  it('reads no ripgrep configuration file', async () => {
    const config = join(dir, 'ripgreprc');
    await writeFile(config, '--ignore-case\n--hidden\n');
    const before = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = config;
    try {
      expect(await (await search('NEEDLE')).matchingLines(['needle'])).toEqual([[]]);
    } finally {
      if (before === undefined) delete process.env.RIPGREP_CONFIG_PATH;
      else process.env.RIPGREP_CONFIG_PATH = before;
    }
  });

  it('reads a leading dash as the pattern, never as a flag', async () => {
    await put('kb/f.md', 'use --files here\n');
    const files = await all(await search('--files'));
    expect(files).toEqual([{ path: 'f.md', lines: [{ line: 1, text: 'use --files here' }] }]);
  });

  it('stops a walk at the budget with the 400, killing the run', async () => {
    const slow = await slowRipgrep();
    try {
      const s = await search('needle', { budgetMs: 300 });
      const started = Date.now();
      await expect(all(s)).rejects.toMatchObject({ status: 400, details: { code: 'pattern_too_expensive' } });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await slow.alive()).toEqual([]);
      // The budget is the search's: spent, every later run is refused at once.
      await expect(s.matchingLines(['needle'])).rejects.toMatchObject({ details: { code: 'pattern_too_expensive' } });
    } finally {
      await slow.remove();
    }
  });

  it('ends the run when the caller stops reading, and gives its slot back', async () => {
    for (let i = 0; i < 50; i++) await put(`kb/f${String(i).padStart(2, '0')}.md`, 'needle\n');
    const m = matcher({ maxRunning: 1, maxWaiting: 0 });
    const s = await m.search('needle', { ignoreCase: false });
    for await (const f of s.files({ cwd: dir, root: 'kb' }, { excludeExtensions: [], excludePaths: [], maxLinesPerFile: 1 })) {
      expect(f.path).toBe('f00.md');
      break;
    }
    // With one slot and no queue, a run still holding it would make this a 503.
    expect(await (await m.search('needle', { ignoreCase: false })).matchingLines(['needle'])).toEqual([[0]]);
  });

  it('spends one budget across every run of a search, so runs that each finish can still exhaust it', async () => {
    // Each walk takes 400 ms and finishes; the third has 200 ms of a 1 s budget left.
    const slow = await slowRipgrep({ walkMs: 400 });
    try {
      const s = await search('needle', { budgetMs: 1_000 });
      expect(await all(s)).toEqual([]);
      expect(await s.list({ cwd: dir, root: 'kb' })).toEqual([]);
      const started = Date.now();
      await expect(all(s)).rejects.toMatchObject({ status: 400, details: { code: 'pattern_too_expensive' } });
      expect(Date.now() - started).toBeLessThan(400);
      expect(await slow.alive()).toEqual([]);
    } finally {
      await slow.remove();
    }
  });

  it('kills every run when the caller goes away, answers it abandoned, and gives the slot back', async () => {
    const slow = await slowRipgrep();
    try {
      const m = matcher({ maxRunning: 1, maxWaiting: 0 });
      const gone = new AbortController();
      const s = await m.search('needle', { ignoreCase: false, signal: gone.signal });
      const running = all(s);
      while ((await slow.alive()).length === 0) await new Promise((r) => setTimeout(r, 20));
      const started = Date.now();
      gone.abort();
      await expect(running).rejects.toMatchObject({ status: 499, details: { code: 'search_abandoned' } });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(await slow.alive()).toEqual([]);
      // A later run of the abandoned search is refused before it starts.
      await expect(s.matchingLines(['needle'])).rejects.toMatchObject({ details: { code: 'search_abandoned' } });
      expect(await (await m.search('needle', { ignoreCase: false })).matchingLines(['needle'])).toEqual([[0]]);
    } finally {
      await slow.remove();
    }
  });

  it('refuses a run past the queue with a 503 and ends every run on close', async () => {
    const slow = await slowRipgrep();
    try {
      const m = matcher({ maxRunning: 1, maxWaiting: 0 });
      const s = await m.search('needle', { ignoreCase: false });
      const running = all(s);
      while ((await slow.alive()).length === 0) await new Promise((r) => setTimeout(r, 20));
      await expect(m.search('needle', { ignoreCase: false })).rejects.toMatchObject({ status: 503, details: { code: 'search_busy' } });
      await m.close();
      await expect(running).rejects.toMatchObject({ status: 503 });
      expect(await slow.alive()).toEqual([]);
    } finally {
      await slow.remove();
    }
  });

  it('refuses sizes it cannot work with', () => {
    expect(() => new RipgrepPatternMatcher({ maxRunning: 0 })).toThrow(/maxRunning must be an integer from 1 /);
    expect(() => new RipgrepPatternMatcher({ budgetMs: 0 })).toThrow(/budgetMs/);
    expect(() => new RipgrepPatternMatcher({ maxWaiting: -1 })).toThrow(/maxWaiting/);
  });
});
