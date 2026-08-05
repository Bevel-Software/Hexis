import { useCallback, useMemo, useState } from 'react';
import { MessageSquare, MessagesSquare } from 'lucide-react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { usePrViewer } from '../state/pr-viewer.context';
import { useAuth } from '../../auth/state/auth.context';
import {
  approvePrFile,
  unapprovePrFile,
} from '../services/pr-approvals.api';
import {
  deletePrComment,
  editPrComment,
  postPrComment,
} from '../services/pr-comments.api';
import { PrHeader } from './PrHeader';
import { PrFilesList } from './PrFilesList';
import { PrDiffPane } from './PrDiffPane';
import { PrCommentsPanel } from './PrCommentsPanel';

/**
 * Full-overlay PR viewer. Mounts when `openPrNumber` is set — sits on top of
 * the file viewer in the main content area (same absolute-inset-0 strategy as
 * the agent-change ReviewPanel).
 */
type CommentScope = 'file' | 'all';

const PR_LAYOUT_ID = 'bevel-pr-viewer-v1';
const PR_PANEL_IDS = ['files', 'diff', 'comments'];
const SEPARATOR_CLASS =
  'w-px bg-sunken hover:bg-accent-hover/60 data-[dragging=true]:bg-accent-hover transition-colors outline-none focus-visible:bg-accent-hover cursor-col-resize';

function getSafeLocalStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const storage = window.localStorage;
    const probeKey = `${PR_LAYOUT_ID}:storage-probe`;
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return undefined;
  }
}

export function PrViewer() {
  const { openPrNumber, detail, selectedPath, isLoading, lastError, notFound, closeViewer, selectPath, refresh } =
    usePrViewer();
  const { user } = useAuth();
  const currentUserEmail = user?.email ?? '';

  // "Current file" is the more useful default for multi-file PRs — when a reviewer
  // lands on a file they want to see that file's discussion first, not the whole thread.
  const [commentScope, setCommentScope] = useState<CommentScope>('file');

  const layoutStorage = useMemo(() => getSafeLocalStorage(), []);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: PR_LAYOUT_ID,
    panelIds: PR_PANEL_IDS,
    storage: layoutStorage,
  });

  // Tracks which path has an approve/unapprove request in flight. One-at-a-time
  // keeps the UI simple and prevents a user from firing a second request before
  // the first settles and the detail refreshes.
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const handleApprove = useCallback(
    async (path: string) => {
      if (!openPrNumber || busyPath) return;
      setBusyPath(path);
      try {
        await approvePrFile(openPrNumber, path);
        await refresh();
      } catch (err) {
        console.error('[pr] approveFile failed:', err);
      } finally {
        setBusyPath(null);
      }
    },
    [openPrNumber, busyPath, refresh],
  );

  const handleUnapprove = useCallback(
    async (path: string) => {
      if (!openPrNumber || busyPath) return;
      setBusyPath(path);
      try {
        await unapprovePrFile(openPrNumber, path);
        await refresh();
      } catch (err) {
        console.error('[pr] unapproveFile failed:', err);
      } finally {
        setBusyPath(null);
      }
    },
    [openPrNumber, busyPath, refresh],
  );

  // Inline-comment handlers share the same post/edit/delete API as the side
  // panel. Each awaits refresh() so the diff pane's inline-thread render picks
  // up the new state without a second round-trip. Post/reply/edit rethrow so
  // the composer surfaces the error; delete swallows because the icon button
  // has no UI to show it — log instead, same pattern as handleApprove above.
  const handlePostLineComment = useCallback(
    async (path: string, line: number, body: string) => {
      if (!openPrNumber) return;
      try {
        await postPrComment(openPrNumber, { body, path, line });
        await refresh();
      } catch (err) {
        console.error('[pr] postLineComment failed:', err);
        throw err;
      }
    },
    [openPrNumber, refresh],
  );
  const handleReplyComment = useCallback(
    async (parentId: string, body: string) => {
      if (!openPrNumber) return;
      try {
        await postPrComment(openPrNumber, { body, parentId });
        await refresh();
      } catch (err) {
        console.error('[pr] replyComment failed:', err);
        throw err;
      }
    },
    [openPrNumber, refresh],
  );
  const handleEditComment = useCallback(
    async (commentId: string, body: string) => {
      if (!openPrNumber) return;
      try {
        await editPrComment(openPrNumber, commentId, body);
        await refresh();
      } catch (err) {
        console.error('[pr] editComment failed:', err);
        throw err;
      }
    },
    [openPrNumber, refresh],
  );
  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      if (!openPrNumber) return;
      try {
        await deletePrComment(openPrNumber, commentId);
        await refresh();
      } catch (err) {
        console.error('[pr] deleteComment failed:', err);
      }
    },
    [openPrNumber, refresh],
  );

  const selectedFile = useMemo(() => {
    if (!detail || !selectedPath) return null;
    return detail.files.find((f) => f.path === selectedPath) ?? null;
  }, [detail, selectedPath]);

  // Inline-anchored comments for the currently-selected file. Narrowed here
  // (rather than inside PrDiffPane) so the pane doesn't have to know about
  // the detail shape or run this filter on every re-render.
  const selectedFileLineComments = useMemo(() => {
    if (!detail || !selectedPath) return [];
    return detail.comments.filter(
      (c) => c.path === selectedPath && c.line !== undefined,
    );
  }, [detail, selectedPath]);

  // Unread/count hints on the scope toggle so the user knows there's discussion
  // elsewhere even when they're filtering to one file.
  const commentCounts = useMemo(() => {
    if (!detail) return { total: 0, currentFile: 0 };
    const total = detail.comments.length;
    const currentFile = selectedPath
      ? detail.comments.filter((c) => c.path === selectedPath).length
      : 0;
    return { total, currentFile };
  }, [detail, selectedPath]);

  if (openPrNumber === null) return null;

  if (isLoading && !detail) {
    return (
      <div className="absolute inset-0 z-30 flex flex-col bg-white overflow-hidden">
        <div className="h-10 border-b border-line flex items-center px-3 gap-2 shrink-0">
          <span className="text-sm text-ink">Loading change request…</span>
          <button
            type="button"
            onClick={closeViewer}
            className="ml-auto text-xs text-ink-muted hover:text-ink px-2 py-1 rounded hover:bg-hover"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  // The CR no longer exists (404) — the common case when a routine deep-links a
  // change request whose row is gone (merged and cleaned up, or removed). Show a
  // calm "no longer available" state rather than an alarming red error.
  if (notFound) {
    return (
      <div className="absolute inset-0 z-30 flex flex-col bg-white overflow-hidden">
        <div className="h-10 border-b border-line flex items-center px-3 gap-2 shrink-0">
          <span className="text-sm text-ink">Change request #{openPrNumber}</span>
          <button
            type="button"
            onClick={closeViewer}
            className="ml-auto text-xs text-ink-muted hover:text-ink px-2 py-1 rounded hover:bg-hover"
          >
            Close
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center px-6 text-center">
          <div className="max-w-md space-y-2">
            <div className="text-sm text-ink">
              This change request is no longer available.
            </div>
            <div className="text-xs text-ink-muted">
              It may have been merged and cleaned up, or removed. There's nothing left to review.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (lastError) {
    return (
      <div className="absolute inset-0 z-30 flex flex-col bg-white overflow-hidden">
        <div className="h-10 border-b border-line flex items-center px-3 gap-2 shrink-0">
          <span className="text-sm text-red-700">Couldn't load change request #{openPrNumber}</span>
          <button
            type="button"
            onClick={closeViewer}
            className="ml-auto text-xs text-ink-muted hover:text-ink px-2 py-1 rounded hover:bg-hover"
          >
            Close
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center px-6 text-center">
          <div className="max-w-md space-y-2">
            <div className="text-sm text-ink">Couldn't load this change request.</div>
            <div className="text-xs text-ink-muted">{lastError}</div>
          </div>
        </div>
      </div>
    );
  }

  if (!detail) return null;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-white overflow-hidden">
      <PrHeader detail={detail} onCloseViewer={closeViewer} onResolved={closeViewer} onRefreshed={refresh} />
      <Group
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className="flex-1 flex min-h-0"
      >
        <Panel id="files" defaultSize="20%" minSize="12%" maxSize="40%">
          <div className="h-full flex flex-col">
            <PrFilesList
              files={detail.files}
              approvals={detail.approvals}
              selectedPath={selectedPath}
              currentUserEmail={currentUserEmail}
              busyPath={busyPath}
              onSelect={selectPath}
              onApprove={handleApprove}
              onUnapprove={handleUnapprove}
            />
          </div>
        </Panel>
        <Separator className={SEPARATOR_CLASS} />
        <Panel id="diff" minSize="30%">
          <div className="h-full min-w-0 min-h-0">
            <PrDiffPane
              file={selectedFile}
              lineComments={selectedFileLineComments}
              currentUserEmail={currentUserEmail}
              currentHeadSha={detail.headSha}
              onPostLineComment={(line, body) =>
                selectedFile
                  ? handlePostLineComment(selectedFile.path, line, body)
                  : Promise.resolve()
              }
              onReplyComment={handleReplyComment}
              onEditComment={handleEditComment}
              onDeleteComment={handleDeleteComment}
            />
          </div>
        </Panel>
        <Separator className={SEPARATOR_CLASS} />
        <Panel id="comments" defaultSize="25%" minSize="14%" maxSize="50%">
          <div className="h-full flex flex-col">
            <div className="flex items-center border-b border-line shrink-0">
              <ScopeButton
                active={commentScope === 'file'}
                disabled={!selectedPath}
                onClick={() => setCommentScope('file')}
                icon={<MessageSquare size={11} />}
                label={selectedPath ? 'Current file' : 'File'}
                count={commentCounts.currentFile}
              />
              <ScopeButton
                active={commentScope === 'all'}
                onClick={() => setCommentScope('all')}
                icon={<MessagesSquare size={11} />}
                label="All"
                count={commentCounts.total}
              />
            </div>
            <PrCommentsPanel
              detail={detail}
              filterPath={commentScope === 'file' ? selectedPath : null}
            />
          </div>
        </Panel>
      </Group>
    </div>
  );
}

function ScopeButton({
  active,
  disabled,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  disabled?: boolean;
  onClick(): void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs transition-colors ${
        active
          ? 'bg-white text-ink'
          : 'text-ink-muted hover:text-ink hover:bg-white/50'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {icon}
      {label}
      {count > 0 && (
        <span className={`text-[10px] px-1 rounded ${active ? 'bg-sunken text-ink' : 'bg-sunken text-ink-muted'}`}>
          {count}
        </span>
      )}
    </button>
  );
}
