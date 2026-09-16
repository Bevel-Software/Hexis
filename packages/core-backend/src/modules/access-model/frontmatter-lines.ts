/**
 * THE line-based scan of a `---` frontmatter block, for the access model.
 *
 * The access model deliberately does NOT use the regex splitter in
 * `@bevel-software/platform-shared`: a splice has to put bytes back exactly
 * as it found them — comments, blank lines, the file's own line endings —
 * and that needs the LINES, not two captured strings. Two readers here
 * scanned for the fences separately (the grammar's `extractFrontmatter` and
 * `bodyAfterFrontmatter`, and the splice's `splitFrontmatter`), each with its
 * own copy of the same loop. This is that loop, once.
 *
 * What it decides, and what it leaves to the caller:
 *
 *   - THE FENCE RULE is here: a line whose trimmed form is `---`. So an
 *     indented or trailing-spaced fence counts. (The shared regex splitter is
 *     stricter — see `frontmatter-fences.test.ts`, which pins where the two
 *     disagree so the difference stays deliberate rather than discovered.)
 *   - WHAT AN UNTERMINATED BLOCK MEANS is the caller's: the grammar reads it
 *     as a parse error, the body reader as no body, the splice as a refusal.
 *     One scan, three answers, none of them re-deriving the fences.
 */

/** An opening fence with no closing one — the caller decides what that means. */
export interface UnterminatedFrontmatter {
  kind: 'unterminated';
}

/** No opening fence: the whole text is body. */
export interface NoFrontmatter {
  kind: 'none';
  /** Every line of the text, so a splice can put it back untouched. */
  lines: string[];
  eol: string;
}

/** A closed `---` block. */
export interface ScannedFrontmatter {
  kind: 'frontmatter';
  /** The opening fence line, on its own — a splice writes it back verbatim. */
  open: string[];
  /** The lines BETWEEN the fences. */
  fm: string[];
  /** The closing fence line and everything after it. */
  post: string[];
  /** The text's own line ending, so a rewrite does not dirty every line. */
  eol: string;
}

export type FrontmatterScan = ScannedFrontmatter | NoFrontmatter | UnterminatedFrontmatter;

/** Whether a line IS a fence: `---`, ignoring surrounding whitespace. */
function isFence(line: string | undefined): boolean {
  return line?.trim() === '---';
}

/**
 * The line ending a rewrite of `text` should use: the one MOST of its lines
 * already use.
 *
 * A splice re-joins the whole file with a single separator — the frontmatter
 * array is edited by index, so there is no surviving per-line ending to put
 * back — which makes "which ending?" purely a question of whose lines get
 * rewritten. The majority answers it with the fewest: a consistent file (all
 * LF, or all CRLF, which is every file git checks out) comes back byte for
 * byte, and a MIXED file is normalised towards whatever it mostly already is.
 *
 * The rule this replaces was "CRLF if the text contains one anywhere", which
 * let a single stray CRLF — in the body, in a comment — rewrite every line of
 * a knowledge base's access rules as churn in somebody's change request. Ties
 * (and a file with no line breaks at all) go to the file's FIRST ending, so
 * the answer is always the file's own.
 */
function dominantEol(text: string): string {
  let crlf = 0;
  let lf = 0;
  let firstIsCrlf = false;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    const isCrlf = i > 0 && text[i - 1] === '\r';
    if (crlf + lf === 0) firstIsCrlf = isCrlf;
    if (isCrlf) crlf++;
    else lf++;
  }
  if (crlf > lf) return '\r\n';
  if (lf > crlf) return '\n';
  return firstIsCrlf ? '\r\n' : '\n';
}

/** Scan `text` for a leading `---` block. Decides nothing beyond the fences. */
export function scanFrontmatter(text: string): FrontmatterScan {
  const eol = dominantEol(text);
  const lines = text.split(/\r?\n/);
  if (!isFence(lines[0])) return { kind: 'none', lines, eol };
  for (let i = 1; i < lines.length; i++) {
    if (isFence(lines[i])) {
      return { kind: 'frontmatter', open: lines.slice(0, 1), fm: lines.slice(1, i), post: lines.slice(i), eol };
    }
  }
  return { kind: 'unterminated' };
}
