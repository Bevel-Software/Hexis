/**
 * THE line-based scan of a `---` frontmatter block, for the access model.
 *
 * The access model deliberately does NOT use the two-string splitter in
 * `@bevel-software/platform-shared`: a splice has to put bytes back exactly
 * as it found them — comments, blank lines, the file's own line endings —
 * and that needs the LINES, not two captured strings. Two readers here
 * scanned for the fences separately (the grammar's `extractFrontmatter` and
 * `bodyAfterFrontmatter`, and the splice's `splitFrontmatter`), each with its
 * own copy of the same loop. This is that loop, once.
 *
 * What it decides, and what it leaves to the caller:
 *
 *   - THE FENCE RULE is NOT decided here: it is `isFrontmatterFence` from the
 *     shared package, the same function the splitter asks, so the access
 *     model and the catalog can never again disagree about whether a file
 *     has frontmatter (`frontmatter-fences.test.ts` asserts they agree).
 *   - WHAT AN UNTERMINATED BLOCK MEANS is the caller's: the grammar reads it
 *     as a parse error, the body reader as no body, the splice as a refusal.
 *     One scan, three answers, none of them re-deriving the fences.
 */
import { dominantEol, isFrontmatterFence } from '@bevel-software/platform-shared';

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

/** Whether a line IS a fence — the platform's one rule, shared with the catalog's splitter. */
const isFence = isFrontmatterFence;

/** Scan `text` for a leading `---` block. Decides nothing beyond the fences. */
export function scanFrontmatter(text: string): FrontmatterScan {
  // A splice re-joins the whole file with a single separator: the frontmatter
  // array is edited by index, so there is no surviving per-line ending to put
  // back. The platform's one answer to "which ending?" picks it.
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
