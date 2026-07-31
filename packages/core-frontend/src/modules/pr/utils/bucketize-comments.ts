import type { PrReviewComment } from '@bevel-software/platform-shared';

export interface ThreadBucket {
  root: PrReviewComment;
  replies: PrReviewComment[];
}

/**
 * Group a flat comment list into thread buckets: one root (parent missing or
 * unresolvable) plus its replies, oldest first. Replies whose parent has been
 * deleted re-root at themselves so the discussion doesn't vanish. Two-level-
 * plus chains are flattened to root + replies for rendering simplicity.
 */
export function bucketizeComments(comments: PrReviewComment[]): ThreadBucket[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const roots: ThreadBucket[] = [];
  const rootById = new Map<string, ThreadBucket>();

  for (const c of comments) {
    if (!c.parentId || !byId.has(c.parentId)) {
      const bucket: ThreadBucket = { root: c, replies: [] };
      roots.push(bucket);
      rootById.set(c.id, bucket);
    }
  }
  for (const c of comments) {
    if (c.parentId && byId.has(c.parentId)) {
      let currentParentId: string | undefined = c.parentId;
      let rootBucket: ThreadBucket | undefined;
      const guard = new Set<string>();
      while (currentParentId && !guard.has(currentParentId)) {
        guard.add(currentParentId);
        const direct = rootById.get(currentParentId);
        if (direct) {
          rootBucket = direct;
          break;
        }
        const parent: PrReviewComment | undefined = byId.get(currentParentId);
        currentParentId = parent?.parentId;
      }
      if (rootBucket) {
        rootBucket.replies.push(c);
      } else {
        // Parent chain went unresolved — re-root this comment. Register it
        // in `rootById` too so later descendants that chase this id as their
        // ancestor still find a bucket to attach to; without this the
        // fallback root is orphaned from any grandchildren.
        const fallback: ThreadBucket = { root: c, replies: [] };
        roots.push(fallback);
        rootById.set(c.id, fallback);
      }
    }
  }
  return roots;
}
