import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GitCompare,
  ChevronDown,
  Lock,
  ArrowLeftRight,
  Loader2,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { protectedBranchDisplayName, isProtectedBranch, DEFAULT_BRANCH, type BranchInfo } from '@bevel-software/shared';
import { useGit } from '../state/git.context';
import { UnifiedDiffView } from './UnifiedDiffView';
import { friendlyGitError } from '../services/error-messages';

interface Props {
  filePath: string;
  /**
   * Optional initial picker overrides (used when the agent's chat tool-card
   * deep-links into this panel via a `bevel:open-comparison` event). When
   * omitted, the panel resolves sensible defaults from the workspace state.
   */
  initialFrom?: string | null;
  initialTo?: string | null;
  /**
   * Bumped by the workspace whenever the file system changes (save, delete,
   * tree refresh, etc). When this number changes, the panel refetches the
   * comparison so a save you made on the Content tab shows up here without
   * forcing the user to flip the pickers.
   */
  refreshKey?: number;
}

// The `bevel:open-comparison` deep-link event lives in core/events so
// dispatchers (the chat tool-card) and listeners (FileViewer) don't need to
// import this component module. Re-exported here for compatibility with
// existing import sites.
export {
  OPEN_COMPARISON_EVENT,
  type OpenComparisonDetail,
} from '../../../core/events';

/**
 * Sort branches the same way the BranchSwitcher does: protected first (the
 * default branch ahead of the other protected branches), then drafts
 * alphabetically. Keeps both surfaces showing the same order so users don't
 * have to relearn navigation.
 */
function sortBranchesForPicker(branches: BranchInfo[]): BranchInfo[] {
  return [...branches].sort((a, b) => {
    if (a.isProtected !== b.isProtected) return a.isProtected ? -1 : 1;
    if (a.isProtected && b.isProtected) {
      if (a.name === DEFAULT_BRANCH) return -1;
      if (b.name === DEFAULT_BRANCH) return 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * Pick a sensible `from` for `currentBranch`:
 *  - On a feature branch → its fork base if available, else the protected
 *    branch other than `currentBranch`, else any other branch.
 *  - On a protected branch → the *other* protected branch so the comparison
 *    is non-empty by default (Current vs Target).
 *
 * Returns null if no other branch is available — the panel renders the
 * "pick a different version" empty state in that case.
 */
function defaultFromForCurrent(
  currentBranch: string | null,
  branches: BranchInfo[],
  forkBase: string | null,
): string | null {
  if (!currentBranch || branches.length < 2) return null;

  const others = branches.filter((b) => b.name !== currentBranch);
  if (others.length === 0) return null;

  if (forkBase && forkBase !== currentBranch && others.some((b) => b.name === forkBase)) {
    return forkBase;
  }

  // On a protected branch, prefer the default branch as the comparison base so
  // the picker opens on the canonical "official vs official" diff; if we're
  // already on the default branch, any other protected branch works.
  if (isProtectedBranch(currentBranch)) {
    if (currentBranch !== DEFAULT_BRANCH && others.some((b) => b.name === DEFAULT_BRANCH)) {
      return DEFAULT_BRANCH;
    }
  }

  const protectedOther = others.find((b) => b.isProtected);
  if (protectedOther) return protectedOther.name;

  return others[0].name;
}

export function FileComparisonPanel({ filePath, initialFrom, initialTo, refreshKey = 0 }: Props) {
  const git = useGit();
  const { branches, fetchFileComparison, fetchForkBase } = git;
  const currentBranch = git.status?.branch ?? null;

  const [fromBranch, setFromBranch] = useState<string | null>(initialFrom ?? null);
  const [toBranch, setToBranch] = useState<string | null>(initialTo ?? currentBranch);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the user clicks the manual refresh button — combined with
  // the parent-supplied `refreshKey` so either signal forces a refetch.
  const [manualRefresh, setManualRefresh] = useState(0);
  // Token to drop late-arriving responses when the user changes pickers
  // mid-flight — same pattern as `FileHistoryPanel.selectCommit`.
  const requestSeqRef = useRef(0);
  // Tracks the previous `currentBranch` so we can detect external branch
  // switches and re-sync `to` (when the user hasn't manually overridden it).
  const prevCurrentBranchRef = useRef<string | null>(currentBranch);

  // Resolve a default `from` once branches + currentBranch are known. The
  // user can override it; we only fill in when nothing has been picked yet.
  const sortedBranches = useMemo(() => sortBranchesForPicker(branches), [branches]);
  useEffect(() => {
    if (initialFrom !== undefined && initialFrom !== null) return;
    if (fromBranch !== null) return;
    if (!currentBranch || branches.length === 0) return;
    let cancelled = false;
    (async () => {
      let forkBase: string | null = null;
      try {
        forkBase = await fetchForkBase(currentBranch);
      } catch {
        // fork-base lookup failure is non-fatal; fall through to the
        // protected-counterpart heuristic.
      }
      if (cancelled) return;
      setFromBranch(defaultFromForCurrent(currentBranch, branches, forkBase));
    })();
    return () => {
      cancelled = true;
    };
  }, [initialFrom, fromBranch, currentBranch, branches, fetchForkBase]);

  // Sync `to` to the current branch when the user switches branches outside
  // the panel — matches how the History tab refreshes per branch. Re-sync
  // when `to` is null OR was tracking the previous current branch (i.e. the
  // user hasn't manually overridden it); leave it alone if the user picked a
  // specific branch to compare against.
  useEffect(() => {
    if (initialTo !== undefined && initialTo !== null) {
      prevCurrentBranchRef.current = currentBranch;
      return;
    }
    if (currentBranch) {
      const wasFollowing = toBranch === prevCurrentBranchRef.current;
      if (toBranch === null || wasFollowing) {
        setToBranch(currentBranch);
      }
    }
    prevCurrentBranchRef.current = currentBranch;
  }, [currentBranch, toBranch, initialTo]);

  // Apply external deep-link overrides whenever they change (the FileViewer
  // re-mounts this panel with new initial values when the chat tool-card
  // dispatches `bevel:open-comparison`).
  useEffect(() => {
    if (initialFrom !== undefined && initialFrom !== null) setFromBranch(initialFrom);
    if (initialTo !== undefined && initialTo !== null) setToBranch(initialTo);
  }, [initialFrom, initialTo]);

  // Fetch the diff whenever the picker pair (or the file) changes, and also
  // whenever the workspace's filesystem revision bumps (a save on the
  // Content tab) or the user hits manual refresh. Skip when either side is
  // unset or both sides are equal — those render dedicated empty states
  // and shouldn't burn a network call.
  useEffect(() => {
    if (!fromBranch || !toBranch || fromBranch === toBranch) {
      // Bump the seq so any in-flight fetch resolves into a no-op (its
      // isLatest check fails) — otherwise a late response would re-populate
      // the diff/loading/error we just cleared.
      ++requestSeqRef.current;
      setDiff(null);
      setLoading(false);
      setError(null);
      return;
    }
    const token = ++requestSeqRef.current;
    const isLatest = () => requestSeqRef.current === token;
    setLoading(true);
    setError(null);
    fetchFileComparison(filePath, fromBranch, toBranch)
      .then((d) => {
        if (!isLatest()) return;
        setDiff(d);
      })
      .catch((err) => {
        if (!isLatest()) return;
        setError(friendlyGitError(err));
        setDiff(null);
      })
      .finally(() => {
        if (isLatest()) setLoading(false);
      });
  }, [filePath, fromBranch, toBranch, fetchFileComparison, refreshKey, manualRefresh]);

  const handleSwap = useCallback(() => {
    setFromBranch((prevFrom) => {
      setToBranch(prevFrom);
      return toBranch;
    });
  }, [toBranch]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-white">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 shrink-0">
        <GitCompare size={14} className="text-slate-600 shrink-0" />
        <span className="text-xs text-slate-600 truncate flex-1 min-w-0">
          Compare versions of {filePath}
        </span>
        <button
          type="button"
          onClick={() => setManualRefresh((n) => n + 1)}
          disabled={loading || !fromBranch || !toBranch || fromBranch === toBranch}
          title="Refresh comparison"
          aria-label="Refresh comparison"
          className="p-1 rounded text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 shrink-0">
        <BranchPicker
          label="From"
          value={fromBranch}
          branches={sortedBranches}
          onChange={setFromBranch}
        />
        <button
          type="button"
          onClick={handleSwap}
          disabled={!fromBranch || !toBranch}
          title="Swap From and To"
          aria-label="Swap From and To"
          className="p-1.5 rounded text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowLeftRight size={14} />
        </button>
        <BranchPicker
          label="To"
          value={toBranch}
          branches={sortedBranches}
          onChange={setToBranch}
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border-b border-red-300 text-xs text-red-700 shrink-0">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {(!fromBranch || !toBranch) && !loading && !error && (
          <div className="flex items-center justify-center h-full px-6 text-xs text-slate-600 text-center">
            Pick two versions to compare.
          </div>
        )}
        {fromBranch && toBranch && fromBranch === toBranch && !loading && !error && (
          <div className="flex items-center justify-center h-full px-6 text-xs text-slate-600 text-center">
            Pick two different versions to see what changed.
          </div>
        )}
        {loading && (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-slate-600">
            <Loader2 size={13} className="animate-spin" />
            Loading comparison…
          </div>
        )}
        {!loading && !error && diff !== null && fromBranch !== toBranch && (
          <UnifiedDiffView
            diff={diff}
            emptyMessage="This file is identical on both versions."
          />
        )}
      </div>
    </div>
  );
}

interface BranchPickerProps {
  label: string;
  value: string | null;
  branches: BranchInfo[];
  onChange(name: string): void;
}

function BranchPicker({ label, value, branches, onChange }: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const valueIsProtected = !!value && (
    branches.find((b) => b.name === value)?.isProtected ?? false
  );
  const valueDisplay = value ? protectedBranchDisplayName(value) ?? value : '— pick —';

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-slate-600 mb-0.5">
        {label}
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs rounded bg-slate-100 hover:bg-slate-200 border border-slate-300 text-slate-900 min-w-0"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {valueIsProtected && <Lock size={11} className="text-slate-600 shrink-0" />}
        <span className="truncate flex-1 text-left">{valueDisplay}</span>
        <ChevronDown size={12} className={`text-slate-600 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute top-full left-0 right-0 z-40 mt-1 bg-slate-100 border border-slate-300 rounded-lg shadow-xl max-h-64 overflow-y-auto"
        >
          {branches.length === 0 && (
            <div className="px-3 py-2 text-xs text-slate-600">No branches.</div>
          )}
          {branches.map((b) => {
            const display = protectedBranchDisplayName(b.name);
            const isSelected = b.name === value;
            return (
              <button
                key={b.name}
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(b.name);
                  setOpen(false);
                }}
                className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs ${
                  isSelected
                    ? 'bg-slate-200/80 text-slate-900'
                    : 'text-slate-700 hover:bg-slate-200/60'
                }`}
              >
                {b.isProtected && <Lock size={11} className="text-slate-600 shrink-0" />}
                <span className="truncate flex-1">
                  {display ?? <span className="font-mono">{b.name}</span>}
                </span>
                {display && (
                  <span className="font-mono text-[10px] text-slate-600 shrink-0 truncate max-w-[40%]">
                    {b.name}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
