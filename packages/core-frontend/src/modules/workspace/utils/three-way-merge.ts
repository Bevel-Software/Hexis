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
 */
export function threeWayMerge(base: string, ours: string, theirs: string): string | null {
  if (ours === base) return theirs;
  if (theirs === base || theirs === ours) return ours;
  const regions = diff3Merge(ours.split('\n'), base.split('\n'), theirs.split('\n'), {
    excludeFalseConflicts: true,
  });
  const merged: string[] = [];
  for (const region of regions) {
    if (region.conflict) return null;
    if (region.ok) merged.push(...region.ok);
  }
  return merged.join('\n');
}
