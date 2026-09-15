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

/** Scan `text` for a leading `---` block. Decides nothing beyond the fences. */
export function scanFrontmatter(text: string): FrontmatterScan {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (!isFence(lines[0])) return { kind: 'none', lines, eol };
  for (let i = 1; i < lines.length; i++) {
    if (isFence(lines[i])) {
      return { kind: 'frontmatter', open: lines.slice(0, 1), fm: lines.slice(1, i), post: lines.slice(i), eol };
    }
  }
  return { kind: 'unterminated' };
}
