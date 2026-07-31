/**
 * Count added/removed lines between two text snapshots using LCS. Used to fill
 * `linesAdded` / `linesRemoved` on a PendingChange. The full line-by-line diff
 * is computed on the frontend (DiffViewer), so the backend only needs counts.
 *
 * `null` carries the same "not computed" meaning the rest of the system uses
 * for binary files — we return it when the inputs exceed the LCS cap so
 * consumers can distinguish "no changes" (0 / 0) from "too large to count
 * exactly" (null / null).
 */
export interface LineCounts {
  added: number | null;
  removed: number | null;
}

/**
 * Cap on either input dimension before we abandon exact LCS. The DP table is
 * `(m+1)·(n+1)` numbers; at 10k×10k that's 100M cells / ~800MB of heap on a
 * 64-bit V8 number array, which OOMs the worker. Past this size we surface
 * `null` counts (signalling "approximate / not computed") rather than spend
 * seconds + GBs to compute exact counts that the UI will only render as
 * "Diff is too large".
 */
const MAX_LINES = 10_000;

/**
 * Cap on total DP cells `(m+1)·(n+1)`. Per-dimension MAX_LINES alone admits
 * pathological cases like 9999×9999 (~100M cells, ~800MB heap on V8 number
 * arrays) that still OOM the worker. Gate by total cell count too.
 */
const MAX_DP_CELLS = 4_000_000;

/**
 * Split `text` into logical lines. Treats the empty string as zero lines and
 * strips a single trailing newline so a file ending with "\n" doesn't produce
 * a spurious empty final line that throws off counts.
 */
function toLines(text: string): string[] {
  if (text === '') return [];
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text;
  return stripped.split('\n');
}

export function countLineChanges(oldText: string, newText: string): LineCounts {
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);
  const m = oldLines.length;
  const n = newLines.length;
  if (m >= MAX_LINES || n >= MAX_LINES) {
    return { added: null, removed: null };
  }
  if ((m + 1) * (n + 1) > MAX_DP_CELLS) {
    return { added: null, removed: null };
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  let added = 0;
  let removed = 0;
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      added++;
      j--;
    } else {
      removed++;
      i--;
    }
  }
  return { added, removed };
}
