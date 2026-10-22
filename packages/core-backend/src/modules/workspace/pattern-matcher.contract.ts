import { ToolError } from '../tool-helpers/index.js';

/**
 * The contract for running a CALLER'S regular expression: what `grep` (REST,
 * MCP and `call_tool_chain` alike, one handler) depends on, so it never holds
 * a concrete engine. The one implementation is `RipgrepPatternMatcher`
 * (`ripgrep-search.ts`), owned by the composition root and closed with the
 * graph.
 *
 * The engine is ripgrep's default one: linear-time, so no pattern can stall
 * it, and RE2-style, so it refuses look-around and backreferences. It runs in
 * child processes, never on the request thread. An implementation must stop a
 * search that outlives its budget with {@link PatternTooExpensiveError},
 * refuse a pattern its engine refuses with {@link PatternRefusedError}, and
 * refuse work it cannot take on with {@link SearchBusyError} rather than queue
 * it without bound.
 */
export interface IPatternMatcher {
  /**
   * One search's matcher for `pattern`: its budget is spent across every call
   * it makes. Rejects with the 400 {@link PatternRefusedError} when the engine
   * refuses the pattern, or the 400 `pattern_too_long` an over-long pattern
   * earns, before any file is searched. When `signal` aborts (the caller went
   * away), every run the search has going is killed, and the call it was
   * serving rejects with {@link SearchAbandonedError}.
   */
  search(pattern: string, opts: { ignoreCase: boolean; signal?: AbortSignal }): Promise<IPatternSearch>;
  /** Ends every running search; a search after this is refused. */
  close(): Promise<void>;
}

/** Where a tree search runs: a directory, never a file. */
export interface TreeScope {
  /** Absolute, canonical directory the search runs in. */
  cwd: string;
  /** The directory searched, relative to `cwd` (`.` for `cwd` itself). */
  root: string;
}

/** Which files a tree search opens, and how much of each it keeps. */
export interface TreeSearchOptions {
  /**
   * The files searched, relative to the scope's `root` as
   * {@link IPatternSearch.list} answers them; no other file is opened. A name
   * holding a line break cannot be named to ripgrep exactly and is refused.
   */
  only: readonly string[];
  /** The most lines one file answers; the lines past it are neither kept nor parsed. */
  maxLinesPerFile: number;
}

/** One file's matching lines, as a tree search finds them. */
export interface FileMatches {
  /** The file, relative to the scope's `root`, `/`-separated. */
  path: string;
  /** Its matching lines, in order: 1-based numbers, the whole line without its `\n`. */
  lines: { line: number; text: string }[];
}

/**
 * One search, under one budget.
 *
 * A tree search covers every file under the scope's root: hidden files and
 * folders, files a `.gitignore` or `.ignore` names, untracked files. It never
 * enters a folder named `.git` (in any case), never follows a symbolic link,
 * and reads no configuration of its own. Who may read what is not its
 * business: the caller filters what it answers.
 */
export interface IPatternSearch {
  /**
   * The lines the pattern matches in the `only` files under the scope, one
   * file at a time in {@link compareSearchPaths} order, found by the same walk
   * as {@link list}: a named path that has since become a link is not
   * followed. A file whose content is binary contributes nothing, and neither
   * does a line that is not UTF-8. Each file is answered as soon as ripgrep
   * has finished it (whether a file is binary is known only then), so
   * stopping the iteration stops the search at the file the caller had
   * enough with.
   */
  files(scope: TreeScope, opts: TreeSearchOptions): AsyncIterable<FileMatches>;
  /**
   * Every file under the scope, relative to the root, in
   * {@link compareSearchPaths} order: the walk {@link files} makes, without
   * opening a file — what a caller judges before choosing what is searched.
   */
  list(scope: TreeScope): Promise<string[]>;
  /**
   * For each of `texts`, the 0-based indices of its lines (split on `\n`) that
   * the pattern matches, in order.
   */
  matchingLines(texts: readonly string[]): Promise<number[][]>;
  /**
   * Run `work` the search waits on between its runs (judging which files the
   * caller may read) under the search's one budget: the time it takes is
   * spent from it, and work still running when the budget is gone is
   * answered with {@link PatternTooExpensiveError} — or
   * {@link SearchAbandonedError} when the caller has gone — at once, whatever
   * `work` itself does after.
   */
  charged<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * The order every search answers in: path segment by segment, each compared
 * by its UTF-8 bytes — the order a sorted walk of the tree visits files in, so
 * a folder's files come before a sibling file whose name extends the folder's.
 */
export function compareSearchPaths(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const c = Buffer.compare(Buffer.from(as[i]!, 'utf8'), Buffer.from(bs[i]!, 'utf8'));
    if (c !== 0) return c;
  }
  return as.length - bs.length;
}

/** A search stopped for taking too long — a 400, worded for the caller. */
export class PatternTooExpensiveError extends ToolError {
  constructor(pattern: string, budgetMs: number) {
    super(
      `Pattern too expensive: /${shown(pattern)}/ did not finish within this search's ${budgetMs / 1000} s budget, ` +
        'so it was stopped and nothing was returned. Narrow `path` to the folder you mean, or use a more ' +
        'specific pattern.',
      400,
      { code: 'pattern_too_expensive' },
    );
    this.name = 'PatternTooExpensiveError';
  }
}

/** What the engine accepts, as every refusal and the tool's description say it. */
export const PATTERN_DIALECT =
  "grep runs ripgrep's default regex engine, which takes RE2-style patterns: no look-around and no backreferences.";

/** A pattern the engine refuses — a 400 quoting the engine's own reason. */
export class PatternRefusedError extends ToolError {
  constructor(reason: string) {
    super(`Invalid regex: ${reason}\n${PATTERN_DIALECT}`, 400, { code: 'invalid_pattern' });
    this.name = 'PatternRefusedError';
  }
}

/** Every search slot busy and the queue for one full — a 503, so the caller retries rather than reads a partial answer. */
export class SearchBusyError extends ToolError {
  constructor() {
    super('Too many searches are running at once; try again in a few seconds.', 503, { code: 'search_busy' });
    this.name = 'SearchBusyError';
  }
}

/** A search whose caller went away: its runs were killed, and nobody is waiting for the answer. */
export class SearchAbandonedError extends ToolError {
  constructor() {
    super('The search was stopped because its caller went away.', 499, { code: 'search_abandoned' });
    this.name = 'SearchAbandonedError';
  }
}

function shown(pattern: string): string {
  return pattern.length > 80 ? `${pattern.slice(0, 80)}…` : pattern;
}
