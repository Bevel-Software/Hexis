/**
 * Tiny line-level LCS differ for the Library's compare view and the inline
 * own-suggestion marks. No dependency — the module only needs "which lines were
 * removed / added", not a full myers implementation.
 */

export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

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
 * Diff `before` → `after` line-wise. Output is ordered: for each change run,
 * removed lines (from `before`) come before added lines (from `after`).
 *
 * Cost guard: common prefix/suffix are trimmed first; if the remaining middle
 * is still enormous (> ~4M cells) the middle collapses to one whole-block
 * replace instead of an exact LCS — visually "everything here changed", which
 * is the honest rendering for a file that big anyway.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = toLines(before);
  const b = toLines(after);

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
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same' as const, text }));

  if (midA.length * midB.length > 4_000_000) {
    for (const text of midA) out.push({ kind: 'removed', text });
    for (const text of midB) out.push({ kind: 'added', text });
  } else {
    out.push(...lcsDiff(midA, midB));
  }

  for (const text of a.slice(endA)) out.push({ kind: 'same', text });
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
      out.push({ kind: 'same', text: a[i] });
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
      for (const text of removed) out.push({ kind: 'removed', text });
      for (const text of added) out.push({ kind: 'added', text });
    }
  }
  while (i < n) out.push({ kind: 'removed', text: a[i++] });
  while (j < m) out.push({ kind: 'added', text: b[j++] });
  return out;
}

/** True when the diff contains at least one removed/added line. */
export function hasChanges(lines: DiffLine[]): boolean {
  return lines.some((l) => l.kind !== 'same');
}

/** A run of unchanged lines the reader does not need to see, stated as a count. */
export interface DiffGap {
  kind: 'gap';
  /** How many unchanged lines were folded away. */
  count: number;
}

export type CollapsedDiff = DiffLine | DiffGap;

/**
 * Fold long unchanged stretches into "N unchanged lines", keeping `context`
 * lines either side of every change.
 *
 * A change box answers one question — what is different? — and a proposal that
 * touches two lines of a 300-line SKILL.md should not make the reader scroll
 * 300 lines to find them. Gaps are only worth it when they save more than they
 * cost: a run of `context * 2` or fewer is left alone rather than replaced by a
 * line of text about the same size.
 */
export function collapseUnchanged(lines: DiffLine[], context = 2): CollapsedDiff[] {
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = i - context; k <= i + context; k++) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  });

  const out: CollapsedDiff[] = [];
  let hidden = 0;
  const flush = () => {
    if (hidden > 0) out.push({ kind: 'gap', count: hidden });
    hidden = 0;
  };

  lines.forEach((l, i) => {
    if (keep.has(i)) {
      flush();
      out.push(l);
    } else {
      hidden++;
    }
  });
  flush();
  return out;
}
