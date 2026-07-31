import { describe, it, expect } from 'vitest';
import type { PrReviewComment } from '@bevel-software/platform-shared';
import { bucketizeComments } from '../utils/bucketize-comments';

function comment(overrides: Partial<PrReviewComment>): PrReviewComment {
  return {
    id: overrides.id ?? 'c-1',
    author: overrides.author ?? { email: 'a@x', name: 'A' },
    body: overrides.body ?? 'hi',
    parentId: overrides.parentId,
    headSha: overrides.headSha ?? 'sha',
    path: overrides.path,
    line: overrides.line,
    createdAt: overrides.createdAt ?? '2026-04-20T10:00:00Z',
    updatedAt: overrides.updatedAt,
  };
}

describe('bucketizeComments', () => {
  it('returns empty for empty input', () => {
    expect(bucketizeComments([])).toEqual([]);
  });

  it('buckets a single root comment', () => {
    const c = comment({ id: 'r-1' });
    const out = bucketizeComments([c]);
    expect(out).toEqual([{ root: c, replies: [] }]);
  });

  it('attaches replies to their root, preserving order', () => {
    const root = comment({ id: 'root', createdAt: '2026-04-20T10:00:00Z' });
    const r1 = comment({ id: 'r1', parentId: 'root', createdAt: '2026-04-20T11:00:00Z' });
    const r2 = comment({ id: 'r2', parentId: 'root', createdAt: '2026-04-20T12:00:00Z' });
    const out = bucketizeComments([root, r1, r2]);
    expect(out).toHaveLength(1);
    expect(out[0].root.id).toBe('root');
    expect(out[0].replies.map((c) => c.id)).toEqual(['r1', 'r2']);
  });

  it('flattens nested replies into the same bucket', () => {
    // A reply-to-a-reply chain (r2 -> r1 -> root) must land in the root bucket,
    // not become its own thread.
    const root = comment({ id: 'root' });
    const r1 = comment({ id: 'r1', parentId: 'root' });
    const r2 = comment({ id: 'r2', parentId: 'r1' });
    const out = bucketizeComments([root, r1, r2]);
    expect(out).toHaveLength(1);
    expect(out[0].replies.map((c) => c.id).sort()).toEqual(['r1', 'r2']);
  });

  it('re-roots orphan replies when the parent is deleted', () => {
    // If the user deletes the root, the replies remain but no longer have a
    // parent in the list. They should still render as standalone threads
    // rather than silently disappearing.
    const r1 = comment({ id: 'r1', parentId: 'deleted-root' });
    const r2 = comment({ id: 'r2', parentId: 'deleted-root' });
    const out = bucketizeComments([r1, r2]);
    expect(out).toHaveLength(2);
    expect(out[0].root.id).toBe('r1');
    expect(out[1].root.id).toBe('r2');
  });

  it('handles a parent cycle defensively (no infinite loop)', () => {
    // Cycles shouldn't happen in a well-formed DB, but a malicious or buggy
    // insert (a↔b mutual parent) must not hang the UI. The guard set ensures
    // the walk terminates and the orphans surface as their own threads.
    const a = comment({ id: 'a', parentId: 'b' });
    const b = comment({ id: 'b', parentId: 'a' });
    const out = bucketizeComments([a, b]);
    // Neither points at a valid, unvisited root — both end up as their own
    // buckets. The exact count is less important than "doesn't crash".
    expect(out.length).toBeGreaterThan(0);
  });

  it('preserves multiple independent roots', () => {
    const r1 = comment({ id: 'r1' });
    const r2 = comment({ id: 'r2' });
    const r1_reply = comment({ id: 'r1-r', parentId: 'r1' });
    const out = bucketizeComments([r1, r2, r1_reply]);
    expect(out).toHaveLength(2);
    const byRootId = Object.fromEntries(out.map((b) => [b.root.id, b]));
    expect(byRootId['r1'].replies.map((c) => c.id)).toEqual(['r1-r']);
    expect(byRootId['r2'].replies).toEqual([]);
  });
});
