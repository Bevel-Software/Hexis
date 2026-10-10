import { diff3Merge, diffIndices } from 'node-diff3';

/**
 * Line-based three-way merge of a tab's unsaved edits onto content that
 * changed underneath them.
 *
 * - `base`: the bytes the edits started from (the tab's `savedContent`).
 * - `ours`: the edited text (the tab's `content`).
 * - `theirs`: what the branch holds now.
 *
 * Returns the merged text, or `null` when both sides changed the same lines
 * in different ways — the caller then keeps `theirs` and says the edits could
 * not be merged. Two sides making the identical change are not a conflict.
 *
 * Line endings are compared as LF: the editor hands back LF while a CRLF
 * file's `base` and `theirs` keep their CRs, and diffing those as they are
 * made every line look changed on both sides — a conflict that discarded
 * the edits over an upstream change nowhere near them. The result takes
 * `theirs`' line endings, the file's as the branch holds it, line by line:
 * a line it shares with `theirs` keeps that line's ending, so a file mixing
 * CRLF and LF is not rewritten wholesale; a line that replaced one of
 * `theirs` takes the ending of the line it replaced, and a line only the
 * edits added takes the ending most of `theirs` uses.
 */
export function threeWayMerge(base: string, ours: string, theirs: string): string | null {
  const b = toLf(base);
  const o = toLf(ours);
  const t = toLf(theirs);
  if (o === b) return theirs;
  let merged: string;
  if (t === b || t === o) merged = o;
  else {
    const regions = diff3Merge(o.split('\n'), b.split('\n'), t.split('\n'), {
      excludeFalseConflicts: true,
    });
    const lines: string[] = [];
    for (const region of regions) {
      if (region.conflict) return null;
      if (region.ok) lines.push(...region.ok);
    }
    merged = lines.join('\n');
  }
  return withEndingsOf(theirs, t, merged);
}


/** `merged` (LF) with each line ended as the matching line of `theirs` is. */
function withEndingsOf(theirs: string, theirsLf: string, merged: string): string {
  if (!theirs.includes('\r\n')) return merged;
  const tLines = theirsLf.split('\n');
  // The ending after each line of `theirs`; the last line has none.
  const tEnds = theirs
    .split('\n')
    .map((line, i, all) => (i === all.length - 1 ? '' : line.endsWith('\r') ? '\r\n' : '\n'));
  const crlf = tEnds.filter((e) => e === '\r\n').length;
  const lf = tEnds.filter((e) => e === '\n').length;
  const fallback = crlf >= lf ? '\r\n' : '\n';
  const mLines = merged.split('\n');
  const ends: string[] = new Array(mLines.length).fill(fallback);
  // Lines between the differences are shared with `theirs`, in order.
  let i = 0;
  let j = 0;
  const shareUpTo = (mEnd: number, tEnd: number) => {
    while (i < mEnd && j < tEnd) ends[i++] = tEnds[j++] || fallback;
  };
  for (const d of diffIndices(mLines, tLines)) {
    shareUpTo(d.buffer1[0], d.buffer2[0]);
    for (let k = 0; k < d.buffer1[1] && k < d.buffer2[1]; k++) {
      ends[d.buffer1[0] + k] = tEnds[d.buffer2[0] + k] || fallback;
    }
    i = d.buffer1[0] + d.buffer1[1];
    j = d.buffer2[0] + d.buffer2[1];
  }
  shareUpTo(mLines.length, tLines.length);
  return mLines.map((line, k) => (k === mLines.length - 1 ? line : line + ends[k])).join('');
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
