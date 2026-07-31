/**
 * Tiny line-level LCS differ for the Library's compare view and the inline
 * own-suggestion marks. No dependency — the module only needs "which lines were
 * removed / added", not a full myers implementation.
 */

export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** Split keeping no trailing phantom line for a trailing newline. */
function toLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
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
