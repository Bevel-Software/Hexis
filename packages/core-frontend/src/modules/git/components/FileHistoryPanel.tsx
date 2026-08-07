import { useCallback, useEffect, useRef, useState } from 'react';
import { History, AlertTriangle, Loader2 } from 'lucide-react';
import type { CommitAttribution, FileDiffPayload } from '@bevel-software/platform-shared';
import { useGit } from '../state/git.context';
import { formatRelativeTime } from '../../../lib/utils';
import { UnifiedDiffView } from './UnifiedDiffView';
import { MarkdownDiffViewer } from '../../review/components/MarkdownDiffViewer';
import { friendlyGitError } from '../services/error-messages';
import { useEventBus, canonicalizeWorkspaceId } from '../../workflow/state/event-bus.context';
import { useWorkspace } from '../../workspace/state/workspace.context';

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function isMarkdownPath(p: string): boolean {
  return /\.md$/i.test(p);
}

function formatAbsoluteTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

interface Props {
  filePath: string;
}

export function FileHistoryPanel({ filePath }: Props) {
  const git = useGit();
  const [commits, setCommits] = useState<CommitAttribution[] | null>(null);
  const [selected, setSelected] = useState<CommitAttribution | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  // Markdown files render through the same viewer as "Review agent changes":
  // full before/after contents diffed client-side into a rendered-markdown
  // red/green view. `diff` (the raw patch) stays the path for everything else.
  const [mdPayload, setMdPayload] = useState<FileDiffPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestDiffRequestRef = useRef<string | null>(null);

  // Pull the stable callbacks out so the effect's deps don't include the whole
  // `git` object — that object is a useMemo result that changes on every status
  // poll, which would otherwise wipe local state (selection, loading) every 30s.
  const { fetchFileHistory, fetchFileDiff, fetchFileAtChange } = git;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(null);
    setDiff(null);
    setMdPayload(null);
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
      // Clear any banner left over from a previous failed diff so the UI
      // reflects only the currently-selected save's state.
      setError(null);
      setDiff(null);
      setMdPayload(null);
      setDiffLoading(true);
      latestDiffRequestRef.current = commit.sha;
      if (isMarkdownPath(filePath)) {
        fetchFileAtChange(filePath, commit.sha)
          .then(({ baseline, current }) => {
            if (latestDiffRequestRef.current !== commit.sha) return;
            setMdPayload({
              path: filePath,
              kind: baseline === null ? 'added' : current === null ? 'deleted' : 'modified',
              baseline,
              current,
              isBinary: false,
            });
          })
          .catch((err) => {
            if (latestDiffRequestRef.current === commit.sha) {
              setError(friendlyGitError(err));
            }
          })
          .finally(() => {
            if (latestDiffRequestRef.current === commit.sha) setDiffLoading(false);
          });
        return;
      }
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
    [filePath, fetchFileDiff, fetchFileAtChange],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-white">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line shrink-0">
        <History size={14} className="text-ink-muted shrink-0" />
        <span className="text-xs text-ink-muted truncate">Timeline: {filePath}</span>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border-b border-red-300 text-xs text-red-700 shrink-0">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
        </div>
      )}
      <div className="flex-1 flex min-h-0">
        {/* Left: commit list */}
        <div className="w-72 shrink-0 overflow-y-auto border-r border-line">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-ink-muted">
              <Loader2 size={13} className="animate-spin" />
              Loading timeline…
            </div>
          )}
          {!loading && commits && commits.length === 0 && (
            <div className="px-3 py-3 text-xs text-ink-muted">
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
                      className={`w-full text-left px-3 py-2 border-b border-line text-xs transition-colors ${
                        isSelected
                          ? 'bg-sunken text-ink'
                          : 'text-ink hover:bg-hover'
                      }`}
                    >
                      {/* Subject leads; SHA moves to a muted pill so non-technical users aren't
                          greeted by a hex string before any human context. */}
                      <div className="flex items-start gap-2">
                        <span className="flex-1 truncate">{c.subject || '(no message)'}</span>
                        <span
                          className="shrink-0 font-mono text-[9px] text-ink-muted bg-white border border-line rounded px-1 py-[1px]"
                          title={`Save id: ${c.sha}`}
                        >
                          {shortSha(c.sha)}
                        </span>
                      </div>
                      <div
                        className="mt-0.5 text-[10px] text-ink-muted truncate"
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

        {/* Right: the selected save's changes */}
        <div className="flex-1 flex flex-col min-w-0">
          {!selected && (
            <div className="flex-1 flex items-center justify-center px-6 text-xs text-ink-muted">
              Pick a save to see what changed.
            </div>
          )}
          {selected && (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-line shrink-0">
                <span className="text-xs text-ink truncate flex-1">
                  {selected.subject || '(no message)'}
                </span>
                <span
                  className="font-mono text-[10px] text-ink-muted shrink-0"
                  title={`Save id: ${selected.sha}`}
                >
                  {shortSha(selected.sha)}
                </span>
              </div>
              <div className="flex-1 overflow-auto">
                {diffLoading && (
                  <div className="flex items-center gap-2 px-3 py-3 text-xs text-ink-muted">
                    <Loader2 size={13} className="animate-spin" />
                    Loading changes…
                  </div>
                )}
                {!diffLoading && mdPayload !== null && (
                  mdPayload.baseline === null && mdPayload.current === null ? (
                    // The commit exists in the file's log but the file is
                    // absent on both sides (e.g. a pure rename elsewhere in
                    // the commit) — mirror the raw view's empty state.
                    <div className="px-3 py-3 text-xs text-ink-muted">
                      No file changes in this save.
                    </div>
                  ) : (
                    <MarkdownDiffViewer payload={mdPayload} />
                  )
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
