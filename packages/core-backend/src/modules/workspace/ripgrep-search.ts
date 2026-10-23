import { spawn, type ChildProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_TIMER_MS, sizingOption } from './worker-pool.js';
import { ToolError } from '../tool-helpers/index.js';
import { logger } from '../../shared/logging.js';
import {
  compareSearchPaths,
  type FileMatches,
  type IPatternMatcher,
  type IPatternSearch,
  type TreeScope,
  type TreeSearchOptions,
  PatternRefusedError,
  PatternTooExpensiveError,
  SearchAbandonedError,
  SearchBusyError,
} from './pattern-matcher.contract.js';

const log = logger('grep');

/**
 * The one place a CALLER'S regular expression is run (see
 * {@link IPatternMatcher}): ripgrep, as a child process of the server.
 *
 * Every run is `rg` started WITHOUT a shell, with the caller's pattern after
 * `-e` and the searched path after `--`, so nothing the caller sends can
 * become an option; `--no-config` keeps `RIPGREP_CONFIG_PATH` out of it. A
 * tree is walked sorted by path (`--sort path`), so an answer is stable and a
 * caller that has enough stops the walk.
 *
 * Each run is owned by the call that started it, which kills it on every way
 * out: the walk finished, the caller stopped reading, the budget ran out, the
 * search's caller went away (its abort signal), or an error. `close()` kills
 * whatever is still running.
 */
export interface RipgrepPatternMatcherOptions {
  /** Wall time one search's runs may spend, summed over every run it makes. Default 5 s. */
  budgetMs?: number;
  /** ripgrep runs at once; a run past this waits for one to end. Default 4. */
  maxRunning?: number;
  /** Runs that may wait at once; past it a search is refused with a 503. Default 16. */
  maxWaiting?: number;
  /** Longest pattern accepted. Default 1000. */
  maxPatternLength?: number;
}

/** The flags every run starts with: ripgrep's own configuration file is never read, and bytes are searched as they are. */
const BASE_ARGS = ['--no-config', '--encoding', 'none'];

/**
 * What a tree walk covers: hidden files, ignored files (no `.gitignore`,
 * `.ignore` or global excludes apply), never a symbolic link, never a `.git`
 * folder in any case, files visited sorted by path.
 */
const WALK_ARGS = ['--hidden', '--no-ignore', '--no-follow', '--no-messages', '--sort', 'path'];

/** Last among a walk's globs, so no extension a caller lets through can bring a `.git` folder back. */
const NO_GIT = ['--iglob', '!.git'];

/** How much of a refused run's stderr is kept. */
const STDERR_CAP = 4_096;

type Released = () => void;

/** What a search borrows from its matcher: a slot to run in, and the one way to start `rg`. */
type Runner = {
  slot(): Promise<Released>;
  start(args: string[], cwd: string | undefined, withInput: boolean): ChildProcess;
  /** Whether `close()` has run: a run it killed is answered busy. */
  isClosed(): boolean;
};

export class RipgrepPatternMatcher implements IPatternMatcher {
  private readonly budgetMs: number;
  private readonly maxRunning: number;
  private readonly maxWaiting: number;
  private readonly maxPatternLength: number;
  private readonly runner: Runner;
  private readonly live = new Set<ChildProcess>();
  private readonly waiting: { resolve: () => void; reject: (err: Error) => void }[] = [];
  private running = 0;
  private closed = false;

  constructor(opts: RipgrepPatternMatcherOptions = {}) {
    this.budgetMs = option('budgetMs', opts.budgetMs ?? 5_000, 1, MAX_TIMER_MS);
    // None running would leave every search waiting for a slot that never comes.
    this.maxRunning = option('maxRunning', opts.maxRunning ?? 4, 1);
    this.maxWaiting = option('maxWaiting', opts.maxWaiting ?? 16, 0);
    this.maxPatternLength = option('maxPatternLength', opts.maxPatternLength ?? 1_000, 1);
    this.runner = {
      slot: () => this.slot(),
      start: (args, cwd, withInput) => this.start(args, cwd, withInput),
      isClosed: () => this.closed,
    };
  }

  async search(pattern: string, opts: { ignoreCase: boolean; signal?: AbortSignal }): Promise<IPatternSearch> {
    if (pattern.length > this.maxPatternLength) {
      throw new ToolError(
        `Pattern too long: ${pattern.length} characters, and a search pattern may have at most ${this.maxPatternLength}.`,
        400,
        { code: 'pattern_too_long' },
      );
    }
    // A process argument cannot carry a NUL; the escape `\x00` can.
    if (pattern.includes('\0')) throw new PatternRefusedError('a pattern cannot contain a NUL character; write it as \\x00.');
    const search = new RipgrepSearch(this.runner, pattern, opts.ignoreCase ? ['-i'] : [], this.budgetMs, opts.signal);
    // The engine judges the pattern before anything is searched, so a refused
    // one is answered as such whatever the search would have found.
    await search.matchingLines(['']);
    return search;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const w of this.waiting.splice(0)) w.reject(new SearchBusyError());
    const exits = [...this.live].map((child) => exited(child));
    for (const child of this.live) child.kill('SIGKILL');
    await Promise.all(exits);
  }

  /** A run's slot: given at once while fewer than `maxRunning` run, else after a wait. */
  private async slot(): Promise<Released> {
    if (this.closed) throw new SearchBusyError();
    if (this.running < this.maxRunning) {
      this.running++;
    } else {
      if (this.waiting.length >= this.maxWaiting) throw new SearchBusyError();
      // Resolved by a run that ends: its slot passes straight to this one.
      await new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next.resolve();
      else this.running--;
    };
  }

  /** Start `rg` from the server's PATH with `args`, registered so `close()` can end it. */
  private start(args: string[], cwd: string | undefined, withInput: boolean): ChildProcess {
    if (this.closed) throw new SearchBusyError();
    const child = spawn('rg', args, {
      cwd,
      shell: false,
      stdio: [withInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.live.add(child);
    child.once('close', () => this.live.delete(child));
    // A spawn that fails emits 'error' and never 'close'.
    child.once('error', () => this.live.delete(child));
    return child;
  }
}

/** One search: the pattern, its flags, and what is left of its budget. */
class RipgrepSearch implements IPatternSearch {
  private spentMs = 0;

  constructor(
    private readonly runner: Runner,
    private readonly pattern: string,
    private readonly flags: string[],
    private readonly budgetMs: number,
    private readonly signal: AbortSignal | undefined,
  ) {}

  async *files(scope: TreeScope, opts: TreeSearchOptions): AsyncIterable<FileMatches> {
    // Without a single whitelist glob ripgrep would search every file.
    if (opts.only.length === 0) return;
    // Each file is named by a whitelist glob anchored at `cwd`, where ripgrep
    // runs: the walk stays the walk (no link followed, `.git` left out), and
    // a file not named is never opened. Whitelist globs filter files only, so
    // the walks start at the folders holding the named files rather than at
    // the root, and a folder's own files are walked without its subfolders:
    // a batch of a large tree walks about its own stretch of it.
    const under = scope.root === '.' ? '' : `${scope.root}/`;
    // Every name is checked before the first run, so none is half-searched.
    for (const p of opts.only) exactGlob(`${under}${p}`);
    let only = opts.only;
    while (only.length > 0) {
      const capped = yield* this.walkFiles(scope, under, only, opts.maxLinesPerFile);
      if (capped === null) return;
      // ripgrep stopped reading the file at its cap, so a NUL past it went
      // unseen: the file is read on for one, by a run of its own once the
      // walk's has ended, and the walk goes on with the files after it.
      if (!(await this.holdsNul(scope, under, capped.path))) yield capped;
      only = only.filter((p) => compareSearchPaths(p, capped.path) > 0);
    }
  }

  /**
   * The walks of `only`, each file answered at its `end`, until one reaches
   * `maxLinesPerFile` lines: the walk ends there, and that file is returned
   * unanswered. `null` once every walk has finished.
   */
  private async *walkFiles(scope: TreeScope, under: string, only: readonly string[], maxLinesPerFile: number): AsyncGenerator<FileMatches, FileMatches | null> {
    // `--max-count`: a file is read no further than the lines it may answer.
    const cap = ['--max-count', String(maxLinesPerFile)];
    for (const walk of await realWalks(scope, walkPlan(only))) {
      const globs = walk.paths.flatMap((p) => ['--glob', exactGlob(`${under}${p}`)]);
      const depth = walk.ownFilesOnly ? ['--max-depth', '1'] : [];
      const args = [...BASE_ARGS, '--json', ...WALK_ARGS, ...depth, ...cap, ...globs, ...NO_GIT, ...this.flags, '-e', this.pattern, '--', ...walk.folders];
      let current: FileMatches | null = null;
      for await (const record of this.run(args, scope.cwd, undefined, '\n')) {
        const event = parseEvent(record);
        if (event === null) continue;
        if (event.type === 'begin') {
          const path = underRoot(scope.root, pathOf(event.data?.path));
          current = path === null ? null : { path, lines: [] };
        } else if (event.type === 'match' && current !== null) {
          const text = textOf(event.data?.lines);
          const line = event.data?.line_number;
          if (text !== null && typeof line === 'number' && current.lines.length < maxLinesPerFile) {
            current.lines.push({ line, text: withoutNewline(text) });
          }
        } else if (event.type === 'end' && current !== null) {
          // A file ripgrep found binary part-way through is not text: whatever
          // it matched before the NUL is dropped with the rest. That is known
          // only here, so a file is answered at its end and not before.
          const binary = event.data?.binary_offset !== null && event.data?.binary_offset !== undefined;
          if (!binary && current.lines.length >= maxLinesPerFile) return current;
          if (!binary && current.lines.length > 0) yield current;
          current = null;
        }
      }
    }
    return null;
  }

  /**
   * Whether `path` (relative to the root) holds a NUL anywhere, read by a walk
   * of its own, which follows no link and stops at the first NUL.
   */
  private async holdsNul(scope: TreeScope, under: string, path: string): Promise<boolean> {
    for (const walk of await realWalks(scope, walkPlan([path]))) {
      const depth = walk.ownFilesOnly ? ['--max-depth', '1'] : [];
      const glob = ['--glob', exactGlob(`${under}${path}`)];
      const args = [...BASE_ARGS, '--files-with-matches', ...WALK_ARGS, ...depth, ...glob, ...NO_GIT, '--text', '-e', '\\x00', '--', ...walk.folders];
      for await (const record of this.run(args, scope.cwd, undefined, '\n')) if (record.length > 0) return true;
    }
    return false;
  }

  async list(scope: TreeScope): Promise<string[]> {
    if (await rootMoved(scope)) return [];
    const args = [...BASE_ARGS, '--files', '--null', ...WALK_ARGS, ...NO_GIT, '--', scope.root];
    const out: string[] = [];
    for await (const record of this.run(args, scope.cwd, undefined, '\0')) {
      const path = underRoot(scope.root, record);
      if (path !== null) out.push(path);
    }
    return out;
  }

  async matchingLines(texts: readonly string[]): Promise<number[][]> {
    const hits: number[][] = texts.map(() => []);
    if (texts.length === 0) return hits;
    // One run for every text: they go in one after another, and each line
    // number that comes back is placed in the text it fell in. The final `\n`
    // makes ripgrep's lines exactly the texts' `split('\n')`, empty last line
    // included.
    const starts: number[] = [];
    let lines = 0;
    for (const text of texts) {
      starts.push(lines);
      lines += countLines(text);
    }
    const args = [...BASE_ARGS, '--json', '--text', ...this.flags, '-e', this.pattern, '-'];
    for await (const record of this.run(args, undefined, `${texts.join('\n')}\n`, '\n')) {
      const event = parseEvent(record);
      const n = event?.type === 'match' ? event.data?.line_number : undefined;
      if (typeof n !== 'number') continue;
      const at = n - 1;
      const which = lastStartAtOrBefore(starts, at);
      hits[which]!.push(at - starts[which]!);
    }
    return hits;
  }

  async charged<T>(work: () => Promise<T>): Promise<T> {
    if (this.signal?.aborted) throw new SearchAbandonedError();
    const remaining = this.budgetMs - this.spentMs;
    if (remaining <= 0) throw new PatternTooExpensiveError(this.pattern, this.budgetMs);
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    // The work is not ours to stop; what it settles with after the budget is
    // gone goes nowhere.
    const pending = work();
    pending.catch(() => undefined);
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new PatternTooExpensiveError(this.pattern, this.budgetMs)), remaining);
          onAbort = () => reject(new SearchAbandonedError());
          this.signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) this.signal?.removeEventListener('abort', onAbort);
      this.spentMs += Date.now() - started;
    }
  }

  /**
   * Run ripgrep and yield its stdout split on `separator`. The run is this
   * generator's: it is killed when the caller stops reading, when the
   * search's budget runs out (answered with {@link PatternTooExpensiveError}),
   * when the search's caller goes away (answered with
   * {@link SearchAbandonedError}), and on any error, and its slot is given
   * back on every one of those.
   */
  private async *run(args: string[], cwd: string | undefined, input: string | undefined, separator: string): AsyncGenerator<string> {
    const release = await this.runner.slot();
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let abandoned = false;
    const onAbort = (): void => {
      abandoned = true;
      child?.kill('SIGKILL');
    };
    const started = Date.now();
    try {
      // A caller gone while this run waited for its slot gets no run at all.
      if (this.signal?.aborted) throw new SearchAbandonedError();
      const remaining = this.budgetMs - this.spentMs;
      if (remaining <= 0) throw new PatternTooExpensiveError(this.pattern, this.budgetMs);
      child = this.runner.start(args, cwd, input !== undefined);
      this.signal?.addEventListener('abort', onAbort, { once: true });
      // Listening for a failed spawn first, so its error wins over the exit it also causes.
      const failed = new Promise<never>((_, reject) => child!.once('error', reject));
      failed.catch(() => undefined);
      const exit = exited(child);
      timer = setTimeout(() => {
        timedOut = true;
        child!.kill('SIGKILL');
      }, remaining);
      let stderr = '';
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        if (stderr.length < STDERR_CAP) stderr += chunk;
      });
      if (input !== undefined) {
        // ripgrep may finish (or be killed) before it reads everything.
        child.stdin!.on('error', () => undefined);
        child.stdin!.end(input);
      }
      child.stdout!.setEncoding('utf8');
      // Only each new chunk is scanned, and a record's parts are joined once,
      // when it ends: a record of many chunks (a match on one long line) costs
      // its length, not its length times its chunks.
      const parts: string[] = [];
      for await (const chunk of child.stdout! as AsyncIterable<string>) {
        let from = 0;
        let at: number;
        while ((at = chunk.indexOf(separator, from)) >= 0) {
          parts.push(chunk.slice(from, at));
          const record = parts.join('');
          parts.length = 0;
          from = at + 1;
          yield record;
        }
        if (from < chunk.length) parts.push(from === 0 ? chunk : chunk.slice(from));
      }
      const rest = parts.join('');
      if (rest.length > 0 && !timedOut && !abandoned) yield rest;
      const { code } = await Promise.race([exit, failed]);
      if (abandoned) throw new SearchAbandonedError();
      if (timedOut) throw new PatternTooExpensiveError(this.pattern, this.budgetMs);
      if (code === null && this.runner.isClosed()) throw new SearchBusyError();
      // 0: matches, 1: none. 2 with nothing on stderr is a file ripgrep could
      // not read with `--no-messages` on, which is a file to skip; 2 with a
      // message is the run itself refused.
      if (code === 2 && stderr.trim().length > 0) throw refusal(stderr);
      if (code !== 0 && code !== 1 && code !== 2) throw new Error(`ripgrep ended with exit code ${String(code)}`);
    } catch (err) {
      if (abandoned) throw new SearchAbandonedError();
      if (timedOut) throw new PatternTooExpensiveError(this.pattern, this.budgetMs);
      throw err;
    } finally {
      this.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        const exit = exited(child);
        child.kill('SIGKILL');
        await exit;
      }
      this.spentMs += Date.now() - started;
      release();
    }
  }
}

/** Resolves when `child` has exited and its streams are closed (or it never started). */
function exited(child: ChildProcess): Promise<{ code: number | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode });
  return new Promise((resolve) => {
    child.once('close', (code: number | null) => resolve({ code }));
    child.once('error', () => resolve({ code: null }));
  });
}

/**
 * The error for a run ripgrep refused. A pattern it cannot compile is the
 * caller's to fix, so its own reason is quoted, without the advice to pass
 * flags the caller has no way to pass. Anything else is the server's failure,
 * logged rather than shown.
 */
function refusal(stderr: string): Error {
  const reason = stderr
    .replace(/^rg: /, '')
    .split(/\n\s*\n/)
    .filter((part) => !/^\s*Consider enabling/.test(part))
    .join('\n\n')
    .trim();
  if (/regex|pattern/i.test(reason)) return new PatternRefusedError(reason);
  log.error(`ripgrep failed: ${reason}`);
  return new Error('The search engine failed; see the server log.');
}

type RgEvent = {
  type?: string;
  data?: {
    path?: unknown;
    lines?: unknown;
    line_number?: unknown;
    binary_offset?: unknown;
  };
};

/** One `--json` record, or null for a line that is not one. */
function parseEvent(record: string): RgEvent | null {
  try {
    const event = JSON.parse(record) as unknown;
    return event !== null && typeof event === 'object' ? (event as RgEvent) : null;
  } catch {
    return null;
  }
}

/** ripgrep's `{ text }` or base64 `{ bytes }` (a name that is not UTF-8) as a path. */
function pathOf(value: unknown): string | null {
  const v = value as { text?: unknown; bytes?: unknown } | undefined;
  if (typeof v?.text === 'string') return v.text;
  if (typeof v?.bytes === 'string') return Buffer.from(v.bytes, 'base64').toString('utf8');
  return null;
}

/** A line's text, or null for one that is not UTF-8 (`{ bytes }`), which is not text. */
function textOf(value: unknown): string | null {
  const v = value as { text?: unknown } | undefined;
  return typeof v?.text === 'string' ? v.text : null;
}

function withoutNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** `path` as ripgrep printed it (under `root`), relative to `root`; null when it is not under it. */
function underRoot(root: string, path: string | null): string | null {
  if (path === null) return null;
  const prefix = `${root}/`;
  return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : null;
}

/**
 * The glob that names exactly `path` (relative to where ripgrep runs):
 * anchored with `/`, every character a glob reads specially escaped. A line
 * break has no exact spelling in a glob, and a near one could name a sibling
 * too, so such a name is refused rather than approximated.
 */
function exactGlob(path: string): string {
  if (/[\r\n]/.test(path)) throw new Error(`a search cannot name ${JSON.stringify(path)} exactly: it holds a line break`);
  return `/${path.replace(/[\\*?[\]{}!# ]/g, (c) => `\\${c}`)}`;
}

/** One ripgrep run of a tree search: the folders it walks, in order, the files it answers, and whether it keeps to the folders' own files. */
interface Walk {
  /** Relative to the scope's root; `''` is the root. */
  folders: string[];
  /** The files of the batch this run answers, relative to the root: no other is opened. */
  paths: string[];
  /** Walk each folder's own files, none of its subfolders (`--max-depth 1`). */
  ownFilesOnly: boolean;
}

/**
 * Runs one search makes at most for one batch of files: a folder whose own
 * files and subfolders alternate costs a run per alternation, and past this
 * many the batch is walked in the fewer, wider runs a folder walked whole
 * gives.
 */
const MAX_WALKS = 8;

/**
 * The runs a walk of `paths` (in {@link compareSearchPaths} order, relative
 * to the root) makes, in order. The paths are one stretch of a sorted walk,
 * so in each folder only the first and the last child can hold files outside
 * it: those subfolders are narrowed further, every child between is walked
 * whole, and a folder's own files are walked by a run that keeps to them —
 * which a subfolder sorting between two of them splits, so a folder that
 * alternates costs a run per stretch. Run one after another, the walks visit
 * the files in the order one walk of the root would. Past {@link MAX_WALKS},
 * a folder holding any of the paths directly is walked whole instead.
 */
function walkPlan(paths: readonly string[]): Walk[] {
  if (paths.length === 0) return [];
  const fine = plan(paths, true);
  return fine.length <= MAX_WALKS ? fine : plan(paths, false);
}

function plan(paths: readonly string[], ownFiles: boolean): Walk[] {
  const walks: Walk[] = [];
  // Consecutive runs of one kind are one run given several folders; a
  // folder's own files with nothing walked between them are one folder.
  const push = (folder: string, ownFilesOnly: boolean, group: readonly string[][]): void => {
    const paths = group.map((segments) => segments.join('/'));
    const last = walks[walks.length - 1];
    if (last === undefined || last.ownFilesOnly !== ownFilesOnly) {
      walks.push({ folders: [folder], paths, ownFilesOnly });
      return;
    }
    if (!(ownFilesOnly && last.folders[last.folders.length - 1] === folder)) last.folders.push(folder);
    last.paths.push(...paths);
  };
  const cover = (folder: string, depth: number, group: readonly string[][]): void => {
    const holdsFiles = group.some((segments) => segments.length === depth + 1);
    if (holdsFiles && !ownFiles) {
      push(folder, false, group);
      return;
    }
    const children: string[][][] = [];
    for (const segments of group) {
      const last = children[children.length - 1];
      if (last !== undefined && last[0]![depth] === segments[depth]) last.push(segments);
      else children.push([segments]);
    }
    children.forEach((child, i) => {
      if (child[0]!.length === depth + 1) {
        push(folder, true, child);
        return;
      }
      const name = child[0]!.slice(0, depth + 1).join('/');
      if (i === 0 || i === children.length - 1) cover(name, depth + 1, child);
      else push(name, false, child);
    });
  };
  cover('', 0, paths.map((p) => p.split('/')));
  return walks;
}

/**
 * `walks` as ripgrep is given them — when each folder is still the real
 * folder the walk listed. ripgrep follows a link it is GIVEN, so a folder
 * that has become a link since (or is gone) sends the search back to one walk
 * of the root, whose `--no-follow` never enters it. The root is checked
 * again here, as where the scope was made: one that has become a link since
 * is given to ripgrep not at all, and nothing is walked.
 */
async function realWalks(scope: TreeScope, walks: readonly Walk[]): Promise<Walk[]> {
  if (walks.length === 0 || (await rootMoved(scope))) return [];
  const folders = [...new Set(walks.flatMap((w) => w.folders).filter((folder) => folder !== ''))];
  const real = await Promise.all(folders.map((folder) => isRealFolder(scope.cwd, `${scope.root}/${folder}`)));
  if (!real.every(Boolean)) return [{ folders: [scope.root], paths: walks.flatMap((w) => w.paths), ownFilesOnly: false }];
  return walks.map((w) => ({
    ...w,
    folders: w.folders.map((folder) => (folder === '' ? scope.root : `${scope.root}/${folder}`)),
  }));
}

/**
 * Whether the scope's root now resolves elsewhere: it, or a folder above it,
 * has become a link since the scope was made. A root that is gone holds
 * nothing for ripgrep to find, so it is walked as it is.
 */
async function rootMoved(scope: TreeScope): Promise<boolean> {
  const absolute = join(scope.cwd, scope.root);
  return (await realpath(absolute).catch(() => absolute)) !== absolute;
}

/** Whether `folder` (relative to `cwd`) is still itself: no link on the way to it, and there. */
async function isRealFolder(cwd: string, folder: string): Promise<boolean> {
  const absolute = join(cwd, folder);
  return (await realpath(absolute).catch(() => null)) === absolute;
}

function countLines(text: string): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** The index of the last start at or before `at` (starts ascending, `starts[0]` is 0). */
function lastStartAtOrBefore(starts: number[], at: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function option(name: string, value: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  return sizingOption('RipgrepPatternMatcher', name, value, min, max);
}
