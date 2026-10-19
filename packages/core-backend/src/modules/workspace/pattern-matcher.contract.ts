import { ToolError } from '../tool-helpers/tool.contract.js';

/**
 * The contract for running a CALLER'S regular expression: what `grep` (REST,
 * MCP and `call_tool_chain` alike, one handler) depends on, so it never holds
 * a concrete engine. The one implementation is `WorkerPatternMatcher`
 * (`bounded-matcher.ts`), owned by the composition root and closed with the
 * graph.
 *
 * JavaScript's engine backtracks, so a pattern like `^(a+)+$` over a line of
 * forty `a`s and a `!` never finishes. An implementation must therefore never
 * run the pattern on the request thread, must stop a search whose matching
 * outlives its budget with {@link PatternTooExpensiveError}, and must refuse
 * work it cannot take on with {@link SearchBusyError} rather than queue it
 * without bound. Within budget, a pattern matches exactly the lines
 * `RegExp#test` does.
 */
export interface IPatternMatcher {
  /**
   * One search's matcher for `source`/`flags`: its budget is spent across
   * every call it makes. Throws the 400 `Invalid regex` the caller's syntax
   * earns, or the 400 `pattern_too_long` an over-long pattern earns.
   */
  search(source: string, flags: string): IPatternSearch;
  /** Ends the workers; a search after this is refused. */
  close(): Promise<void>;
}

/** One search, under one budget. */
export interface IPatternSearch {
  /**
   * The indices of the lines the pattern matches, in order, at most `limit` of
   * them (the first `limit`, exactly as a loop that stops at the cap finds).
   * Throws {@link PatternTooExpensiveError} once the search's budget is spent.
   */
  matchingLines(lines: string[], limit: number): Promise<number[]>;
}

/** A pattern stopped for taking too long — a 400, worded for the caller. */
export class PatternTooExpensiveError extends ToolError {
  constructor(pattern: string, budgetMs: number) {
    super(
      `Pattern too expensive: /${pattern.length > 80 ? `${pattern.slice(0, 80)}…` : pattern}/ did not finish matching within this search's ${budgetMs / 1000} s budget, ` +
        'so it was stopped and nothing was returned. Patterns with nested or overlapping repetition such as ' +
        '`(a+)+` or `(a|aa)*` can take exponential time on some lines. Use a simpler pattern — a literal, ' +
        'an anchor, a character class, a single repetition — or narrow `path`.',
      400,
      { code: 'pattern_too_expensive' },
    );
    this.name = 'PatternTooExpensiveError';
  }
}

/** Every worker busy and the queue for one full — a 503, so the caller retries rather than reads a partial answer. */
export class SearchBusyError extends ToolError {
  constructor() {
    super('Too many searches are running at once; try again in a few seconds.', 503, { code: 'search_busy' });
    this.name = 'SearchBusyError';
  }
}

/**
 * Whether `err` ends a whole search rather than one file's part of it: a
 * directory walk that skipped a file for either would answer an incomplete
 * result as if it were the whole one.
 */
export function endsTheSearch(err: unknown): boolean {
  return err instanceof PatternTooExpensiveError || err instanceof SearchBusyError;
}
