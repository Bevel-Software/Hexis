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
 * (or old-Mac CR-only) file's `base` and `theirs` keep their CRs, and diffing those as they are
 * made every line look changed on both sides — a conflict that discarded
 * the edits over an upstream change nowhere near them. The result takes
 * `theirs`' line endings, the file's as the branch holds it, line by line:
 * a line it shares with `theirs` keeps that line's ending, so a file mixing
 * CRLF and LF is not rewritten wholesale; a line that replaced one of
 * `theirs` takes the ending of the line it replaced, and a line only the
 * edits added takes the ending most of `theirs` uses. CRLF, LF and a lone
 * CR are each restored as they were.
 */
export function threeWayMerge(base: string, ours: string, theirs: string): string | null {
  const b = toLf(base);
  const o = toLf(ours);
  const t = toLf(theirs);
  if (o === b) return theirs;
  let merged: string;
  if (t === b || t === o) merged = o;
  else {
    const middle = mergeLines(o.split('\n'), b.split('\n'), t.split('\n'));
    if (middle === null) return null;
    merged = middle.join('\n');
  }
  return withEndingsOf(theirs, t, merged);
}

/**
 * The lines all three share at the start and at the end are kept as they are
 * and only what lies between is diffed: node-diff3 is slow on long input and
 * spreads each unchanged region into one `push` call, which overruns the
 * engine's argument limit (about 120k lines) — a long file edited near one
 * end threw instead of merging. Lines are appended one by one for the same
 * reason. An unchanged run that long between two changes still overruns it
 * inside the dependency; that file is reported as not mergeable.
 */
function mergeLines(o: string[], b: string[], t: string[]): string[] | null {
  const shortest = Math.min(o.length, b.length, t.length);
  let head = 0;
  while (head < shortest && o[head] === b[head] && t[head] === b[head]) head++;
  let tail = 0;
  while (tail < shortest - head
    && o[o.length - 1 - tail] === b[b.length - 1 - tail]
    && t[t.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  let regions: ReturnType<typeof diff3Merge<string>>;
  try {
    regions = diff3Merge(
      o.slice(head, o.length - tail),
      b.slice(head, b.length - tail),
      t.slice(head, t.length - tail),
      { excludeFalseConflicts: true },
    );
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
  const lines = b.slice(0, head);
  for (const region of regions) {
    if (region.conflict) return null;
    if (region.ok) for (const line of region.ok) lines.push(line);
  }
  for (let k = b.length - tail; k < b.length; k++) lines.push(b[k]);
  return lines;
}

/** `merged` (LF) with each line ended as the matching line of `theirs` is. */
function withEndingsOf(theirs: string, theirsLf: string, merged: string): string {
  if (!theirs.includes('\r')) return merged;
  const tLines = theirsLf.split('\n');
  // The ending after each line of `theirs`; the last line has none. The
  // capture group keeps each separator at the odd indices of the split.
  const parts = theirs.split(/(\r\n|\r|\n)/);
  const tEnds = tLines.map((_, i) => parts[2 * i + 1] ?? '');
  const counts = new Map<string, number>();
  for (const e of tEnds) if (e) counts.set(e, (counts.get(e) ?? 0) + 1);
  let fallback = '\r\n';
  for (const [e, n] of counts) if (n > (counts.get(fallback) ?? 0)) fallback = e;
  const mLines = merged.split('\n');
  const ends: string[] = new Array(mLines.length).fill(fallback);
  // The lines `merged` shares with `theirs` at the start and at the end keep
  // their endings as they are, and only what lies between is diffed, as in
  // `mergeLines`: a long file is slow to diff whole, and a long CRLF file
  // is the case that reaches here.
  const shortest = Math.min(mLines.length, tLines.length);
  let head = 0;
  while (head < shortest && mLines[head] === tLines[head]) head++;
  let tail = 0;
  while (tail < shortest - head
    && mLines[mLines.length - 1 - tail] === tLines[tLines.length - 1 - tail]) tail++;
  for (let k = 0; k < head; k++) ends[k] = tEnds[k] || fallback;
  for (let k = 1; k <= tail; k++) ends[mLines.length - k] = tEnds[tLines.length - k] || fallback;
  const mMid = mLines.slice(head, mLines.length - tail);
  const tMid = tLines.slice(head, tLines.length - tail);
  // Lines between the differences are shared with `theirs`, in order.
  let i = 0;
  let j = 0;
  const shareUpTo = (mEnd: number, tEnd: number) => {
    while (i < mEnd && j < tEnd) ends[head + i++] = tEnds[head + j++] || fallback;
  };
  for (const d of diffIndices(mMid, tMid)) {
    shareUpTo(d.buffer1[0], d.buffer2[0]);
    for (let k = 0; k < d.buffer1[1] && k < d.buffer2[1]; k++) {
      ends[head + d.buffer1[0] + k] = tEnds[head + d.buffer2[0] + k] || fallback;
    }
    i = d.buffer1[0] + d.buffer1[1];
    j = d.buffer2[0] + d.buffer2[1];
  }
  shareUpTo(mMid.length, tMid.length);
  return mLines.map((line, k) => (k === mLines.length - 1 ? line : line + ends[k])).join('');
}

function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
