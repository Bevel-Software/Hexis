import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
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

/**
 * Every listed file searched, as grep's text pass does: the listing first,
 * then the files it named, less those with an `exclude` extension or named in
 * `skip`.
 */
async function all(
  s: IPatternSearch,
  exclude: string[] = [],
  opts: Partial<Pick<TreeSearchOptions, 'maxLinesPerFile'>> & { root?: string; skip?: string[] } = {},
): Promise<FileMatches[]> {
  const { root = 'kb', skip = [], maxLinesPerFile = 1_000 } = opts;
  const scope = { cwd: root === '.' ? join(dir, 'kb') : dir, root };
  const only = (await s.list(scope)).filter((p) => !exclude.some((ext) => p.toLowerCase().endsWith(ext)) && !skip.includes(p));
  const out: FileMatches[] = [];
  for await (const f of s.files(scope, { only, maxLinesPerFile })) out.push(f);
  return out;
}

async function put(rel: string, content: string | Buffer): Promise<void> {
  const p = join(dir, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, content);
}

/**
 * The real `rg`, put first on PATH behind a script that records where each
 * tree search starts (what follows its `--`); `last()` answers the latest.
 */
async function recordWalks(): Promise<{ last(): Promise<string[]>; runs(): Promise<string[][]>; remove(): Promise<void> }> {
  const real = (await promisify(execFile)('sh', ['-c', 'command -v rg'])).stdout.trim();
  const shim = await mkdtemp(join(tmpdir(), 'rec-rg-'));
  const log = join(shim, 'walks');
  await writeFile(
    join(shim, 'rg'),
    [
      '#!/bin/sh',
      'seen=; roots=; prev=; depth=',
      'for a in "$@"; do if [ -n "$seen" ]; then roots="$roots$a$depth|"; elif [ "$a" = "--" ]; then seen=1; elif [ "$prev" = "--max-depth" ]; then depth="@$a"; fi; prev="$a"; done',
      `if [ -n "$seen" ]; then echo "$roots" >> '${log}'; fi`,
      `exec '${real}' "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(join(shim, 'rg'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${shim}${delimiter}${path ?? ''}`;
  return {
    async last() {
      const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
      return lines[lines.length - 1]!.split('|').filter(Boolean);
    },
    // Every run since the last call, each its roots (`@1`: its own files only).
    async runs() {
      const lines = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
      await writeFile(log, '');
      return lines.map((line) => line.split('|').filter(Boolean));
    },
    async remove() {
      process.env.PATH = path;
      await rm(shim, { recursive: true, force: true });
    },
  };
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

  it('searches exactly the files it is given, whatever their names, from any root', async () => {
    const names = ['secret.md', 'we ird[1]/#c*.md', '!d.md', 'e.md ', '{f,g}.md', 'back\\slash.md', 'q?.md'];
    for (const n of names) await put(`kb/${n}`, 'needle\n');
    await put('kb/open.md', 'needle\n');
    await put('kb/qx.md', 'needle\n');
    for (const root of ['kb', '.']) {
      // Each special name is given alone: it must name itself and nothing else.
      expect((await all(await search('needle'), [], { root, skip: names })).map((f) => f.path), root).toEqual(['open.md', 'qx.md']);
      const scope = { cwd: root === '.' ? join(dir, 'kb') : dir, root };
      for (const n of names) {
        const files: string[] = [];
        for await (const f of (await search('needle')).files(scope, { only: [n], maxLinesPerFile: 10 })) files.push(f.path);
        expect(files, `${root}: ${n}`).toEqual([n]);
      }
    }
  });

  it('never follows a given name that is a link, refuses a name it cannot spell, and runs nothing for no file', async () => {
    await put('kb/target.md', 'needle\n');
    await symlink(join(dir, 'kb/target.md'), join(dir, 'kb/link.md'));
    const s = await search('needle');
    const scope = { cwd: dir, root: 'kb' };
    const found = async (only: string[]): Promise<string[]> => {
      const out: string[] = [];
      for await (const f of s.files(scope, { only, maxLinesPerFile: 10 })) out.push(f.path);
      return out;
    };
    expect(await found(['link.md'])).toEqual([]);
    expect(await found(['link.md', 'target.md'])).toEqual(['target.md']);
    // No whitelist at all would have ripgrep search everything.
    expect(await found([])).toEqual([]);
    await expect(found(['a\nb.md'])).rejects.toThrow(/line break/);
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

  it('walks only the folders holding the files it is given, a folder\'s own files without its subfolders, in the order one walk of the root would', async () => {
    for (const p of ['A/x/1.md', 'A/y/0.md', 'B/2.md', 'C/y/3.md', 'C/z/9.md', 'T/a/1.md', 'T/a/2.md', 'T/b/3.md', 'top.md', 'U/u.md']) {
      await put(`kb/${p}`, 'needle\n');
    }
    const walked = await recordWalks();
    try {
      const found = async (root: string, only: string[]): Promise<{ paths: string[]; runs: string[][] }> => {
        const scope = { cwd: root === '.' ? join(dir, 'kb') : dir, root };
        const s = await search('needle');
        await walked.runs();
        const paths: string[] = [];
        for await (const f of s.files(scope, { only, maxLinesPerFile: 10 })) paths.push(f.path);
        return { paths, runs: await walked.runs() };
      };
      expect(await found('kb', ['T/a/1.md', 'T/a/2.md'])).toEqual({ paths: ['T/a/1.md', 'T/a/2.md'], runs: [['kb/T/a@1']] });
      // The first and last folder are narrowed, every one between walked whole.
      expect(await found('kb', ['A/x/1.md', 'B/2.md', 'C/y/3.md'])).toEqual({
        paths: ['A/x/1.md', 'B/2.md', 'C/y/3.md'],
        runs: [['kb/A/x@1'], ['kb/B'], ['kb/C/y@1']],
      });
      expect(await found('.', ['T/a/2.md', 'T/b/3.md'])).toEqual({ paths: ['T/a/2.md', 'T/b/3.md'], runs: [['./T/a@1', './T/b@1']] });
      // A file directly in a folder is reached by walking that folder's own
      // files, not its subfolders: the root's file walks the root one deep.
      expect(await found('kb', ['T/b/3.md', 'top.md'])).toEqual({ paths: ['T/b/3.md', 'top.md'], runs: [['kb/T/b@1', 'kb@1']] });
      expect(await found('kb', ['top.md'])).toEqual({ paths: ['top.md'], runs: [['kb@1']] });
    } finally {
      await walked.remove();
    }
  });

  it('answers a folder\'s own files on both sides of a subfolder once each, in order', async () => {
    for (const p of ['a.md', 'M/m.md', 'M/deep/d.md', 'z.md']) await put(`kb/${p}`, 'needle\n');
    const walked = await recordWalks();
    try {
      const s = await search('needle');
      await walked.runs();
      const paths: string[] = [];
      for await (const f of s.files({ cwd: dir, root: 'kb' }, { only: ['a.md', 'M/deep/d.md', 'M/m.md', 'z.md'], maxLinesPerFile: 10 })) paths.push(f.path);
      expect(paths).toEqual(['a.md', 'M/deep/d.md', 'M/m.md', 'z.md']);
      expect(await walked.runs()).toEqual([['kb@1'], ['kb/M'], ['kb@1']]);
    } finally {
      await walked.remove();
    }
  });

  it('walks a folder whole rather than run once per alternation when its files and subfolders alternate past the cap', async () => {
    const only: string[] = [];
    for (let i = 0; i < 12; i++) {
      const name = `p${String(i).padStart(2, '0')}`;
      only.push(`${name}.md`, `${name}/x.md`);
      await put(`kb/${name}.md`, 'needle\n');
      await put(`kb/${name}/x.md`, 'needle\n');
    }
    only.sort(compareSearchPaths);
    const walked = await recordWalks();
    try {
      const s = await search('needle');
      await walked.runs();
      const paths: string[] = [];
      for await (const f of s.files({ cwd: dir, root: 'kb' }, { only, maxLinesPerFile: 10 })) paths.push(f.path);
      expect(paths).toEqual(only);
      expect(await walked.runs()).toEqual([['kb']]);
    } finally {
      await walked.remove();
    }
  });

  it('walks from the root when a folder it would start at has become a link, so the link is not followed', async () => {
    await put('kb/T/a/1.md', 'x\n');
    await put('outside/1.md', 'needle\n');
    const s = await search('needle');
    const scope = { cwd: dir, root: 'kb' };
    const only = await s.list(scope);
    expect(only).toEqual(['T/a/1.md']);
    // Listed as a folder, then swapped for a link out before the search runs.
    await rm(join(dir, 'kb/T/a'), { recursive: true });
    await symlink(join(dir, 'outside'), join(dir, 'kb/T/a'));
    const walked = await recordWalks();
    try {
      const paths: string[] = [];
      for await (const f of s.files(scope, { only, maxLinesPerFile: 10 })) paths.push(f.path);
      expect(paths).toEqual([]);
      expect(await walked.last()).toEqual(['kb']);
    } finally {
      await walked.remove();
    }
  });

  it('walks nothing when the root itself has become a link since the scope was made', async () => {
    await put('kb/T/1.md', 'needle\n');
    await put('outside/T/1.md', 'needle outside\n');
    const s = await search('needle');
    const scope = { cwd: dir, root: 'kb/T' };
    const only = await s.list(scope);
    expect(only).toEqual(['1.md']);
    // The scope's root, checked when it was made, swapped for a link out.
    await rm(join(dir, 'kb/T'), { recursive: true });
    await symlink(join(dir, 'outside/T'), join(dir, 'kb/T'));
    const paths: string[] = [];
    for await (const f of s.files(scope, { only, maxLinesPerFile: 10 })) paths.push(f.path);
    expect(paths).toEqual([]);
    expect(await s.list(scope)).toEqual([]);
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

  it('spends the budget on the work it is charged with, and answers the 400 at the budget when that work outlasts it', async () => {
    const s = await search('needle', { budgetMs: 600 });
    const sleep = (ms: number) => () => new Promise<string>((r) => setTimeout(() => r('done'), ms));
    expect(await s.charged(sleep(200))).toBe('done');
    const started = Date.now();
    await expect(s.charged(sleep(5_000))).rejects.toMatchObject({ status: 400, details: { code: 'pattern_too_expensive' } });
    expect(Date.now() - started).toBeLessThan(1_000);
    // Spent: neither more work nor another run is started.
    await expect(s.charged(sleep(1))).rejects.toMatchObject({ details: { code: 'pattern_too_expensive' } });
    await expect(s.matchingLines(['needle'])).rejects.toMatchObject({ details: { code: 'pattern_too_expensive' } });
    // A failure of the work itself is the caller's to hear.
    const t = await search('needle');
    await expect(t.charged(() => Promise.reject(new Error('verdict failed')))).rejects.toThrow('verdict failed');
  });

  it('answers charged work as abandoned when the caller goes away', async () => {
    const gone = new AbortController();
    const s = await matcher().search('needle', { ignoreCase: false, signal: gone.signal });
    const waiting = s.charged(() => new Promise((r) => setTimeout(r, 5_000)));
    gone.abort();
    await expect(waiting).rejects.toMatchObject({ status: 499 });
  });

  it('ends the run when the caller stops reading, and gives its slot back', async () => {
    for (let i = 0; i < 50; i++) await put(`kb/f${String(i).padStart(2, '0')}.md`, 'needle\n');
    const m = matcher({ maxRunning: 1, maxWaiting: 0 });
    const s = await m.search('needle', { ignoreCase: false });
    const scope = { cwd: dir, root: 'kb' };
    for await (const f of s.files(scope, { only: await s.list(scope), maxLinesPerFile: 1 })) {
      expect(f.path).toBe('f00.md');
      break;
    }
    // With one slot and no queue, a run still holding it would make this a 503.
    expect(await (await m.search('needle', { ignoreCase: false })).matchingLines(['needle'])).toEqual([[0]]);
  });

  it('spends one budget across every run of a search, so runs that each finish can still exhaust it', async () => {
    // Each walk takes 1 s and finishes; the third has 500 ms of a 2.5 s budget left.
    const slow = await slowRipgrep({ walkMs: 1_000 });
    try {
      const s = await search('needle', { budgetMs: 2_500 });
      expect(await all(s)).toEqual([]);
      expect(await s.list({ cwd: dir, root: 'kb' })).toEqual([]);
      const started = Date.now();
      await expect(all(s)).rejects.toMatchObject({ status: 400, details: { code: 'pattern_too_expensive' } });
      expect(Date.now() - started).toBeLessThan(1_000);
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
