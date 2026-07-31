import { useCallback, useEffect, useRef, useState } from 'react';
import { History, Undo2, AlertTriangle, Loader2 } from 'lucide-react';
import type { CommitAttribution } from '@bevel-software/platform-shared';
import { useGit } from '../state/git.context';
import { UnifiedDiffView } from './UnifiedDiffView';
import { friendlyGitError } from '../services/error-messages';
import { useFileAccess } from '../../access/hooks/useFileAccess';
import { useEventBus, canonicalizeWorkspaceId } from '../../workflow/state/event-bus.context';
import { useWorkspace } from '../../workspace/state/workspace.context';

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Human-readable relative time for the timeline ("2 hours ago", "3d ago"). Falls back to
 * an absolute date once we cross ~a month so the label doesn't become meaningless.
 */
function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatAbsoluteTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

interface Props {
  filePath: string;
  /**
   * Called after a successful undo so the parent can reconcile (reopen the file, refresh
   * the tree, refetch status). Returning a Promise lets the panel await reconciliation
   * before clearing its `reverting` flag so buttons don't re-enable while reload is in
   * progress.
   */
  onRevertCompleted(): Promise<void>;
}

export function FileHistoryPanel({ filePath, onRevertCompleted }: Props) {
  const git = useGit();
  const [commits, setCommits] = useState<CommitAttribution[] | null>(null);
  const [selected, setSelected] = useState<CommitAttribution | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latestDiffRequestRef = useRef<string | null>(null);

  // Revert (the backend's `git revert` flow) is gated by per-path write
  // access on protected branches only — draft branches are free-for-all,
  // mirroring the backend's revertCommit gate. The hook returns
  // canWrite=true on drafts without a network call, so the button stays
  // enabled. On protected branches, default-allow on loading / API failure
  // so a transient hiccup doesn't grey out the button for users who
  // actually have access — the backend will refuse with AccessDenied at
  // click time if not. (Edge case: a commit may have touched other files
  // the caller can't write. The backend checks all of them; the user sees
  // a click-then-error for that, which is acceptable.)
  const access = useFileAccess(filePath, git.status?.branch ?? null);
  const cannotRevert = access.canWrite === false;

  // Pull the stable callbacks out so the effect's deps don't include the whole
  // `git` object — that object is a useMemo result that changes on every status
  // poll, which would otherwise wipe local state (selection, loading) every 30s.
  const { fetchFileHistory, fetchFileDiff, revert } = git;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotice(null);
    setSelected(null);
    setDiff(null);
    setCommits(null);
    latestDiffRequestRef.current = null;
    fetchFileHistory(filePath, 20)
      .then((history) => {
        if (cancelled) return;
        setCommits(history);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(friendlyGitError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, fetchFileHistory]);

  // Live refresh: when a commit lands on this file (someone else saves,
  // an agent edit completes, etc.), refetch history so the new commit
  // appears without the user having to switch tabs. Only acts on commit
  // events (`newSha` set) — disk-only writes (mid-edit autosaves) don't
  // change git history so refetching would be wasted work.
  const bus = useEventBus();
  const workspace = useWorkspace();
  const workspaceId = workspace.workspaceId;
  useEffect(() => {
    if (!bus || !workspaceId) return;
    // Per-subscription cancellation. When `filePath`/`workspaceId`
    // changes the effect's cleanup flips this flag, so any in-flight
    // fetchFileHistory from the previous file's events can't resolve
    // and `setCommits` for the new file. Without the guard, a stale
    // resolve would render the old file's commits in the new tab.
    let cancelled = false;
    const workspaceCanon = canonicalizeWorkspaceId(workspaceId);
    const off = bus.subscribe('file-changed', (event) => {
      if (canonicalizeWorkspaceId(event.workspaceId) !== workspaceCanon) return;
      if (event.path !== filePath) return;
      if (event.newSha === null) return;
      // Refetch in the background; ignore failures (the next poll or
      // manual reopen will recover).
      fetchFileHistory(filePath, 20)
        .then((history) => {
          if (cancelled) return;
          setCommits(history);
        })
        .catch((err) => console.warn('[FileHistoryPanel] live refresh failed:', err));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [bus, workspaceId, filePath, fetchFileHistory]);

  const selectCommit = useCallback(
    (commit: CommitAttribution) => {
      setSelected(commit);
      // Clear any banner left over from a previous failed diff/revert so the UI
      // reflects only the currently-selected save's state.
      setError(null);
      setDiff(null);
      setDiffLoading(true);
      latestDiffRequestRef.current = commit.sha;
      fetchFileDiff(filePath, commit.sha)
        .then((d) => {
          if (latestDiffRequestRef.current === commit.sha) setDiff(d);
        })
        .catch((err) => {
          if (latestDiffRequestRef.current === commit.sha) {
            setError(friendlyGitError(err));
          }
        })
        .finally(() => {
          if (latestDiffRequestRef.current === commit.sha) setDiffLoading(false);
        });
    },
    [filePath, fetchFileDiff],
  );

  const handleRevert = useCallback(async () => {
    if (!selected || reverting) return;
    setError(null);
    setNotice(null);
    setReverting(true);
    try {
      const attr = await revert(selected.sha);
      setNotice(`Undone. Created a new save (${shortSha(attr.sha)}) that reverses ${shortSha(selected.sha)}.`);
      await onRevertCompleted();
    } catch (err) {
      setError(friendlyGitError(err));
    } finally {
      setReverting(false);
    }
  }, [revert, selected, reverting, onRevertCompleted]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-white">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 shrink-0">
        <History size={14} className="text-slate-600 shrink-0" />
        <span className="text-xs text-slate-600 truncate">Timeline — {filePath}</span>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border-b border-red-300 text-xs text-red-700 shrink-0">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
        </div>
      )}
      {notice && !error && (
        <div className="px-3 py-2 bg-emerald-50 border-b border-emerald-200/60 text-xs text-emerald-700 shrink-0">
          {notice}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Left: commit list */}
        <div className="w-72 shrink-0 overflow-y-auto border-r border-slate-200">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-slate-600">
              <Loader2 size={13} className="animate-spin" />
              Loading timeline…
            </div>
          )}
          {!loading && commits && commits.length === 0 && (
            <div className="px-3 py-3 text-xs text-slate-600">
              Nothing has been saved to this file yet.
            </div>
          )}
          {!loading && commits && commits.length > 0 && (
            <ul>
              {commits.map((c) => {
                const isSelected = selected?.sha === c.sha;
                const who = c.authorName || c.authorEmail || 'unknown';
                return (
                  <li key={c.sha}>
                    <button
                      type="button"
                      onClick={() => selectCommit(c)}
                      className={`w-full text-left px-3 py-2 border-b border-slate-200/60 text-xs transition-colors ${
                        isSelected
                          ? 'bg-slate-100 text-slate-900'
                          : 'text-slate-700 hover:bg-slate-100/80'
                      }`}
                    >
                      {/* Subject leads; SHA moves to a muted pill so non-technical users aren't
                          greeted by a hex string before any human context. */}
                      <div className="flex items-start gap-2">
                        <span className="flex-1 truncate">{c.subject || '(no message)'}</span>
                        <span
                          className="shrink-0 font-mono text-[9px] text-slate-500 bg-white border border-slate-200 rounded px-1 py-[1px]"
                          title={`Save id: ${c.sha}`}
                        >
                          {shortSha(c.sha)}
                        </span>
                      </div>
                      <div
                        className="mt-0.5 text-[10px] text-slate-600 truncate"
                        title={formatAbsoluteTime(c.committedAt)}
                      >
                        {who} · {formatRelativeTime(c.committedAt)}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Right: diff + revert */}
        <div className="flex-1 flex flex-col min-w-0">
          {!selected && (
            <div className="flex-1 flex items-center justify-center px-6 text-xs text-slate-600">
              Pick a save to see what changed.
            </div>
          )}
          {selected && (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 shrink-0">
                <span className="text-xs text-slate-700 truncate flex-1">
                  {selected.subject || '(no message)'}
                </span>
                <span
                  className="font-mono text-[10px] text-slate-600 shrink-0"
                  title={`Save id: ${selected.sha}`}
                >
                  {shortSha(selected.sha)}
                </span>
                <button
                  type="button"
                  onClick={handleRevert}
                  disabled={reverting || cannotRevert || git.availability !== 'ready'}
                  title={
                    cannotRevert
                      ? "You don't have permission to edit this file"
                      : 'Creates a new save that reverses this one'
                  }
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-900 border border-slate-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {reverting ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Undo2 size={12} />
                  )}
                  Undo this save
                </button>
              </div>
              <div className="flex-1 overflow-auto">
                {diffLoading && (
                  <div className="flex items-center gap-2 px-3 py-3 text-xs text-slate-600">
                    <Loader2 size={13} className="animate-spin" />
                    Loading changes…
                  </div>
                )}
                {!diffLoading && diff !== null && (
                  <UnifiedDiffView
                    diff={diff}
                    emptyMessage="No file changes in this save."
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
