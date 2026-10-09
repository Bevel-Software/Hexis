import { diff3Merge } from 'node-diff3';

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
 * `theirs`' line endings, the file's as the branch holds it.
 */
export function threeWayMerge(base: string, ours: string, theirs: string): string | null {
  const eol = theirs.includes('\r\n') ? '\r\n' : '\n';
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
  return eol === '\n' ? merged : merged.replace(/\n/g, eol);
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
