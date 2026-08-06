/**
 * The change-requests view of the app's ONE line differ.
 *
 * The engine — LCS, CRLF normalisation, prefix/suffix trimming, the cost
 * guard — lives in `workspace/utils/diff.ts` and is shared with the review
 * module's rendered-markdown viewer. This file only adapts its output to the
 * `kind` shape this module's components speak, and adds the presentation
 * folding (`collapseUnchanged`) that only change boxes need.
 */

import { computeDiff } from '../../workspace/utils/diff';

export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/**
 * Diff `before` → `after` line-wise. Output is ordered: for each change run,
 * removed lines (from `before`) come before added lines (from `after`).
 */
export function diffLines(before: string, after: string): DiffLine[] {
  return computeDiff(before, after).map((l) => ({ kind: l.type, text: l.text }));
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
  // The lines themselves, not a running count: a short run is emitted as-is,
  // so we have to still be holding it when the run ends.
  let hidden: DiffLine[] = [];
  const flush = () => {
    if (hidden.length === 0) return;
    if (hidden.length > context * 2) out.push({ kind: 'gap', count: hidden.length });
    else out.push(...hidden);
    hidden = [];
  };

  lines.forEach((l, i) => {
    if (keep.has(i)) {
      flush();
      out.push(l);
    } else {
      hidden.push(l);
    }
  });
  flush();
  return out;
}
