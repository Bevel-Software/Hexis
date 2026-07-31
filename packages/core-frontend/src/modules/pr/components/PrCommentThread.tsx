import { useState } from 'react';
import { Pencil, Trash2, MessageSquare } from 'lucide-react';
import type { PrReviewComment } from '@bevel-software/platform-shared';
import { PrCommentComposer } from './PrCommentComposer';

interface Props {
  /** Root comment of the thread. */
  root: PrReviewComment;
  /** All replies under the root, oldest first. */
  replies: PrReviewComment[];
  currentUserEmail: string;
  /** True if the root was authored against a SHA that is no longer the PR head. */
  isStale: boolean;
  onPostReply(body: string, parentId: string): Promise<void>;
  onEdit(commentId: string, body: string): Promise<void>;
  onDelete(commentId: string): Promise<void>;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = Date.now();
  const delta = (now - d.getTime()) / 1000;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 7 * 86_400) return `${Math.floor(delta / 86_400)}d ago`;
  return d.toLocaleDateString();
}

export function PrCommentThread({
  root,
  replies,
  currentUserEmail,
  isStale,
  onPostReply,
  onEdit,
  onDelete,
}: Props) {
  const [replying, setReplying] = useState(false);

  return (
    <div className={`rounded border ${isStale ? 'border-slate-200 bg-white/40 opacity-70' : 'border-slate-200 bg-white/60'} px-3 py-2 space-y-2`}>
      <PrCommentRow
        comment={root}
        currentUserEmail={currentUserEmail}
        isStale={isStale}
        onEdit={onEdit}
        onDelete={onDelete}
      />
      {replies.map((r) => (
        <div key={r.id} className="ml-4 pl-3 border-l border-slate-200">
          <PrCommentRow
            comment={r}
            currentUserEmail={currentUserEmail}
            isStale={false}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      ))}
      {replying ? (
        <div className="ml-4 pl-3 border-l border-slate-200">
          <PrCommentComposer
            placeholder="Reply…"
            submitLabel="Reply"
            autoFocus
            onSubmit={async (body) => {
              await onPostReply(body, root.id);
              setReplying(false);
            }}
            onCancel={() => setReplying(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setReplying(true)}
          className="ml-4 flex items-center gap-1 text-[11px] text-slate-600 hover:text-slate-700"
        >
          <MessageSquare size={10} />
          Reply
        </button>
      )}
    </div>
  );
}

function PrCommentRow({
  comment,
  currentUserEmail,
  isStale,
  onEdit,
  onDelete,
}: {
  comment: PrReviewComment;
  currentUserEmail: string;
  isStale: boolean;
  onEdit(commentId: string, body: string): Promise<void>;
  onDelete(commentId: string): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const ownComment = comment.author.email.toLowerCase() === currentUserEmail.toLowerCase();

  if (editing) {
    return (
      <PrCommentComposer
        placeholder="Edit comment…"
        submitLabel="Save"
        autoFocus
        initialValue={comment.body}
        onSubmit={async (body) => {
          await onEdit(comment.id, body);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="font-medium text-slate-900">{comment.author.name || comment.author.email}</span>
        <span className="text-slate-500">·</span>
        <span className="text-slate-600" title={new Date(comment.createdAt).toLocaleString()}>
          {formatTime(comment.createdAt)}
          {comment.updatedAt && comment.updatedAt !== comment.createdAt && ' (edited)'}
        </span>
        {isStale && (
          <span className="text-[10px] text-amber-600 ml-1" title="Authored against an earlier version of the diff">
            outdated
          </span>
        )}
        {ownComment && (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Edit"
              aria-label="Edit comment"
              className="p-0.5 rounded text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            >
              <Pencil size={11} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(comment.id)}
              title="Delete"
              aria-label="Delete comment"
              className="p-0.5 rounded text-slate-600 hover:text-red-700 hover:bg-red-100"
            >
              <Trash2 size={11} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      <div className="mt-1 text-xs text-slate-900 whitespace-pre-wrap break-words">
        {comment.body}
      </div>
      {comment.path && (
        <div className="mt-1 text-[10px] text-slate-600 font-mono truncate">
          {comment.path}{comment.line !== undefined ? `:${comment.line}` : ''}
        </div>
      )}
    </div>
  );
}
