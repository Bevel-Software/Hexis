/**
 * THE line-level differ — every diff surface in the app computes through this
 * one engine. The review module's rendered-markdown viewer consumes it
 * directly; the change-requests module adapts its output shape in
 * `change-requests/utils/diff.ts`. One engine, one set of hardening: CRLF
 * normalisation, prefix/suffix trimming, and a cost guard — bugs fixed here
 * are fixed everywhere, and two surfaces can never disagree about what
 * changed.
 */

export type DiffLine =
  | { type: 'same'; text: string }
  | { type: 'added'; text: string }
  | { type: 'removed'; text: string };

/** Above either cap, the middle degrades to one whole-block replace. */
const MAX_LCS_CELLS = 4_000_000;
const MAX_LCS_SIDE = 100_000;

/**
 * Split keeping no trailing phantom line for a trailing newline.
 *
 * CRLF is normalised away first. A KB file checked out on Windows has `\r\n`
 * endings while a `<textarea>` hands its value back as `\n` (the HTML spec's
 * value normalisation), so without this EVERY line of an edited file compares
 * unequal and a one-word change renders as a whole-file rewrite.
 */
function toLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Diff `oldText` → `newText` line-wise using LCS. Output is ordered: for each
 * change run, removed lines (from `oldText`) come before added lines (from
 * `newText`) — consumers that bundle runs into red/green blocks rely on it.
 *
 * Cost guard: common prefix/suffix are trimmed first; if the remaining middle
 * is still enormous (> ~4M cells) the middle collapses to one whole-block
 * replace instead of an exact LCS — visually "everything here changed", which
 * is the honest rendering for a file that big anyway.
 */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const a = toLines(oldText);
  const b = toLines(newText);

  // Trim common prefix / suffix.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ type: 'same' as const, text }));

  // The cell product alone is not enough: the DP table allocates one row per
  // `midA` line, so a huge side against a tiny (or empty) one passes a
  // product-only check while still allocating millions of rows. Each side is
  // therefore capped independently as well.
  const tooLarge =
    midA.length > MAX_LCS_SIDE ||
    midB.length > MAX_LCS_SIDE ||
    midA.length * midB.length > MAX_LCS_CELLS;
  if (tooLarge) {
    for (const text of midA) out.push({ type: 'removed', text });
    for (const text of midB) out.push({ type: 'added', text });
  } else {
    // Explicit loop, not `out.push(...lines)` — a spread passes every line as
    // a call argument, and engines cap argument counts far below the line
    // counts the guard admits.
    for (const line of lcsDiff(midA, midB)) out.push(line);
  }

  for (const text of a.slice(endA)) out.push({ type: 'same', text });
  return out;
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  // Walk emitting removed-before-added per change run.
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else {
      // Collect one contiguous change run.
      const removed: string[] = [];
      const added: string[] = [];
      while (i < n && j < m && a[i] !== b[j]) {
        if (dp[i + 1][j] >= dp[i][j + 1]) {
          removed.push(a[i]);
          i++;
        } else {
          added.push(b[j]);
          j++;
        }
      }
      for (const text of removed) out.push({ type: 'removed', text });
      for (const text of added) out.push({ type: 'added', text });
    }
  }
  while (i < n) out.push({ type: 'removed', text: a[i++] });
  while (j < m) out.push({ type: 'added', text: b[j++] });
  return out;
}

/** Returns true if two strings differ (ignoring a single terminal newline sequence). */
export function contentChanged(a: string, b: string): boolean {
  const strip = (s: string) => s.endsWith('\r\n') ? s.slice(0, -2) : s.endsWith('\n') ? s.slice(0, -1) : s;
  return strip(a) !== strip(b);
}
