import { useCallback, useMemo, useState } from 'react';
import type { PullRequestDetail } from '@bevel-software/platform-shared';
import {
  deletePrComment,
  editPrComment,
  postPrComment,
} from '../services/pr-comments.api';
import { usePrViewer } from '../state/pr-viewer.context';
import { useAuth } from '../../auth/state/auth.context';
import { bucketizeComments } from '../utils/bucketize-comments';
import { PrCommentThread } from './PrCommentThread';
import { PrCommentComposer } from './PrCommentComposer';

interface Props {
  detail: PullRequestDetail;
  /** When set, filter comments to this file path (plus general thread roots). */
  filterPath?: string | null;
}

export function PrCommentsPanel({ detail, filterPath }: Props) {
  const { refresh } = usePrViewer();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    if (!filterPath) return detail.comments;
    return detail.comments.filter((c) => c.path === filterPath);
  }, [detail.comments, filterPath]);

  const threads = useMemo(() => bucketizeComments(filtered), [filtered]);

  // The composer catches and surfaces errors thrown from onSubmit, so post/reply/edit
  // still get a user-visible failure path. The delete button calls onDelete directly
  // with no composer in the loop — without an explicit catch here that error would
  // disappear into an unhandled rejection. Handle + log uniformly across all four
  // so refresh() only runs on success and the button unbusies either way.
  const handlePostRoot = useCallback(
    async (body: string) => {
      setBusy(true);
      try {
        await postPrComment(detail.number, {
          body,
          path: filterPath ?? undefined,
        });
        await refresh();
      } catch (err) {
        console.error('[pr] postComment failed:', err);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [detail.number, filterPath, refresh],
  );

  const handleReply = useCallback(
    async (body: string, parentId: string) => {
      setBusy(true);
      try {
        await postPrComment(detail.number, { body, parentId });
        await refresh();
      } catch (err) {
        console.error('[pr] replyComment failed:', err);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [detail.number, refresh],
  );

  const handleEdit = useCallback(
    async (commentId: string, body: string) => {
      setBusy(true);
      try {
        await editPrComment(detail.number, commentId, body);
        await refresh();
      } catch (err) {
        console.error('[pr] editComment failed:', err);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [detail.number, refresh],
  );

  const handleDelete = useCallback(
    async (commentId: string) => {
      setBusy(true);
      try {
        await deletePrComment(detail.number, commentId);
        await refresh();
      } catch (err) {
        // Delete is fire-and-forget from the icon button — swallow so React
        // doesn't see an unhandled rejection, but log for ops.
        console.error('[pr] deleteComment failed:', err);
      } finally {
        setBusy(false);
      }
    },
    [detail.number, refresh],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-line text-[11px] uppercase tracking-wide text-ink-muted shrink-0">
        {filterPath ? `Discussion on ${filterPath}` : 'Discussion'}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {threads.length === 0 && (
          <div className="text-xs text-ink-muted italic">
            {filterPath
              ? 'No comments on this file yet.'
              : 'No comments yet. Start the discussion below.'}
          </div>
        )}
        {threads.map((bucket) => (
          <PrCommentThread
            key={bucket.root.id}
            root={bucket.root}
            replies={bucket.replies}
            currentUserEmail={user?.email ?? ''}
            isStale={bucket.root.headSha !== detail.headSha}
            onPostReply={handleReply}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        ))}
      </div>

      <div className="border-t border-line p-3 shrink-0">
        <PrCommentComposer
          placeholder={filterPath ? `Comment on ${filterPath}…` : 'Leave a general comment…'}
          submitLabel="Comment"
          disabled={busy}
          onSubmit={handlePostRoot}
        />
      </div>
    </div>
  );
}
