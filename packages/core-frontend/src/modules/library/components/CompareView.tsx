import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DEFAULT_BRANCH,
  protectedBranchDisplayName,
  type PullRequestDetail,
  type PullRequestSummary,
} from '@bevel-software/platform-shared';
import { useModalLayer } from '../../../shared/components/useModalLayer';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { kbFileUrl } from '../../workspace/routing/kb-routes';
import { fetchPrDetail } from '../../pr/services/pr-detail.api';
import { mergePullRequest } from '../../pr/services/pr-merge.api';
import { cancelPullRequest } from '../../pr/services/pr-cancel.api';
import { postPrComment } from '../../pr/services/pr-comments.api';
import { readFileOnBranch, type LibrarySkill } from '../services/library.api';
import { diffLines, type DiffLine } from '../utils/diff';

interface CompareViewProps {
  skill: LibrarySkill;
  /** Content of a main-side file (SKILL.md body included), null while loading. */
  mainContent(relFile: string): string | null;
  loadMainFile(relFile: string): void;
  cr: PullRequestSummary;
  onClose(): void;
  onResolved(kind: 'applied' | 'sent-back'): void;
}

/**
 * Owner review = compare, not overlay: two panels side by side — left is the
 * skill on the default branch, right is the change-request branch. Removed
 * text tints red on the left, added text green on the right (via the module's
 * line differ over real per-branch file contents); changed files get an amber
 * dot in both lists, files new on the branch get a NEW row. Apply / Send back
 * act through the existing change-request services. Esc exits the compare
 * (registered as its own modal layer so the detail dialog beneath survives).
 */
export function CompareView({
  skill,
  mainContent,
  loadMainFile,
  cr,
  onClose,
  onResolved,
}: CompareViewProps) {
  const navigate = useNavigate();
  const { kbDirName } = useWorkspace();
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchContents, setBranchContents] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const [sendBackNote, setSendBackNote] = useState('');

  const isTop = useModalLayer(true);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isTop()) {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isTop, onClose]);

  useEffect(() => {
    let cancelled = false;
    fetchPrDetail(cr.number)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load this change request.");
      });
    return () => {
      cancelled = true;
    };
  }, [cr.number]);

  const prefix = `${skill.path}/`;
  const mainFiles = useMemo(
    () => ['SKILL.md', ...skill.files.map((f) => f.slice(prefix.length))],
    [skill.files, prefix],
  );
  const changedFiles = useMemo(() => {
    const set = new Set<string>();
    for (const f of detail?.files ?? []) {
      if (f.path.startsWith(prefix)) set.add(f.path.slice(prefix.length));
    }
    return set;
  }, [detail, prefix]);
  const addedFiles = useMemo(
    () =>
      (detail?.files ?? [])
        .filter((f) => f.status === 'added' && f.path.startsWith(prefix))
        .map((f) => f.path.slice(prefix.length)),
    [detail, prefix],
  );
  const outsideCount = useMemo(
    () => (detail?.files ?? []).filter((f) => !f.path.startsWith(prefix)).length,
    [detail, prefix],
  );
  const branchFiles = useMemo(
    () => [...mainFiles, ...addedFiles.filter((f) => !mainFiles.includes(f))],
    [mainFiles, addedFiles],
  );

  // Land on the first changed (or added) file once the detail is in.
  const [selected, setSelected] = useState<string>('SKILL.md');
  const landed = useRef(false);
  useEffect(() => {
    if (!detail || landed.current) return;
    landed.current = true;
    const first = branchFiles.find((f) => changedFiles.has(f));
    if (first) setSelected(first);
  }, [detail, branchFiles, changedFiles]);

  const loadBranchFile = useCallback(
    (rel: string) => {
      if (branchContents[rel] !== undefined) return;
      setBranchContents((c) => ({ ...c, [rel]: null }));
      readFileOnBranch(cr.branch, `${skill.path}/${rel}`)
        .then((content) => setBranchContents((c) => ({ ...c, [rel]: content })))
        .catch(() => setBranchContents((c) => ({ ...c, [rel]: '' })));
    },
    [branchContents, cr.branch, skill.path],
  );

  useEffect(() => {
    loadBranchFile(selected);
    if (!addedFiles.includes(selected)) loadMainFile(selected);
  }, [selected, loadBranchFile, loadMainFile, addedFiles]);

  const isAdded = addedFiles.includes(selected);
  const mainRaw = isAdded ? null : mainContent(selected);
  const branchRaw = branchContents[selected] ?? null;
  const diff: DiffLine[] | null =
    !isAdded && mainRaw !== null && branchRaw !== null ? diffLines(mainRaw, branchRaw) : null;

  async function applyChanges() {
    setBusy(true);
    setError(null);
    try {
      await mergePullRequest(cr.number);
      onResolved('applied');
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't apply this change request.");
      setBusy(false);
    }
  }

  async function sendBack() {
    setBusy(true);
    setError(null);
    try {
      const note = sendBackNote.trim();
      if (note) await postPrComment(cr.number, { body: note });
      await cancelPullRequest(cr.number);
      onResolved('sent-back');
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send this change request back.");
      setBusy(false);
    }
  }

  const fileRow = (rel: string, side: 'main' | 'branch') => {
    const added = addedFiles.includes(rel);
    const active = selected === rel;
    return (
      <button
        key={rel}
        type="button"
        className={`flex w-full items-center gap-2 rounded-[9px] border px-2.5 py-1.5 text-left transition-colors ${
          active
            ? 'border-[#0d9488] bg-[#e6f7f4]'
            : added
              ? 'border-[#a9e8cd] bg-[#f2fcf8] hover:border-[#7fd0c4]'
              : 'border-line bg-[#fafbfd] hover:border-[#7fd0c4]'
        }`}
        onClick={() => setSelected(rel)}
      >
        <span className={`font-mono text-[11.5px] font-semibold ${active ? 'text-[#0f766e]' : 'text-ink-muted'}`}>
          {rel}
        </span>
        {rel === 'SKILL.md' && (
          <span className="rounded-full bg-white px-1.5 text-[9.5px] font-bold tracking-[.04em] text-[#0f766e] shadow-[inset_0_0_0_1px_#d2e9e4]">
            MAIN
          </span>
        )}
        {added && side === 'branch' && (
          <span className="rounded-full bg-[#e0f8ee] px-1.5 text-[9.5px] font-bold tracking-[.04em] text-[#0a8f60]">
            NEW
          </span>
        )}
        {!added && changedFiles.has(rel) && (
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#f59e0b]"
            title="Changed in this request"
          />
        )}
      </button>
    );
  };

  const lineView = (lines: DiffLine[] | null, raw: string | null, hide: 'added' | 'removed') => {
    if (raw === null && lines === null) {
      return <div className="p-3 text-xs text-ink-faint">Loading…</div>;
    }
    const rendered = lines
      ? lines.filter((l) => l.kind !== hide)
      : (raw ?? '').split('\n').map((text) => ({ kind: 'same' as const, text }));
    return (
      <pre className="whitespace-pre-wrap break-words rounded-[13px] border border-line bg-[#f7f9fb] p-3 font-mono text-[11.5px] leading-relaxed text-ink-muted">
        {rendered.map((l, i) => (
          <div
            key={i}
            className={
              l.kind === 'removed'
                ? 'lib-line-removed rounded px-1'
                : l.kind === 'added'
                  ? 'lib-line-added rounded px-1'
                  : 'px-1'
            }
          >
            {l.text || ' '}
          </div>
        ))}
      </pre>
    );
  };

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={`Compare change request: ${cr.title}`}>
      <div className="absolute inset-0 bg-scrim" onClick={onClose} />
      <div className="absolute inset-x-4 bottom-[5vh] top-[5vh] flex gap-3.5">
        {/* left: the default branch */}
        <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-line bg-white shadow-[0_30px_80px_rgba(22,35,58,0.30)]">
          <div className="absolute left-6 right-6 top-0 h-[3px] rounded-full bg-gradient-to-r from-transparent via-[#10b981] to-transparent" />
          <div className="flex items-center gap-3 px-5 pb-3 pt-5">
            <div className="min-w-0">
              <div className="truncate text-[17px] font-bold text-ink">{skill.name}</div>
              <div className="text-[11px] uppercase tracking-[.08em] text-ink-faint">
                Skill · {protectedBranchDisplayName(DEFAULT_BRANCH)}
              </div>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-5 pb-5">
            <h4 className="mb-2 text-[10.5px] font-bold uppercase tracking-[.09em] text-ink-faint">
              Files on {protectedBranchDisplayName(DEFAULT_BRANCH)}
            </h4>
            <div className="mb-4 flex flex-col gap-1.5">{mainFiles.map((f) => fileRow(f, 'main'))}</div>
            <h4 className="mb-2 font-mono text-[11px] text-ink-muted">{selected}</h4>
            {isAdded ? (
              <div className="rounded-[13px] border border-dashed border-line p-4 text-center text-xs text-ink-faint">
                This file doesn't exist here yet
              </div>
            ) : (
              lineView(diff, mainRaw, 'added')
            )}
          </div>
        </section>

        {/* right: the change-request branch */}
        <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-line bg-white shadow-[0_30px_80px_rgba(22,35,58,0.30)]">
          <div className="absolute left-6 right-6 top-0 h-[3px] rounded-full bg-gradient-to-r from-transparent via-[#0d9488] to-transparent" />
          <div className="flex items-center gap-3 px-5 pb-3 pt-5">
            <div className="min-w-0">
              <div className="truncate text-[17px] font-bold text-ink">{cr.title}</div>
              <div className="truncate text-[11px] text-ink-faint">
                <span className="font-mono">{cr.branch}</span>
                {' · by '}
                {cr.appAuthor?.name ?? cr.author.name ?? cr.author.login}
              </div>
            </div>
            <div className="relative ml-auto flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={busy}
                className="rounded-[10px] border border-[#f5c2c2] bg-[#fdecec] px-3.5 py-2 text-[12.5px] font-bold text-[#c53030] transition-transform hover:-translate-y-px disabled:opacity-60"
                onClick={() => setSendBackOpen((o) => !o)}
              >
                Send back
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-[10px] bg-gradient-to-br from-[#0d9488] to-[#0f766e] px-3.5 py-2 text-[12.5px] font-bold text-white shadow-[0_4px_14px_rgba(13,148,136,0.22)] transition-transform hover:-translate-y-px disabled:opacity-60"
                onClick={() => void applyChanges()}
              >
                {busy ? 'Working…' : 'Apply changes'}
              </button>
              <button
                type="button"
                aria-label="Close compare"
                className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-line bg-white text-[13px] text-ink-muted hover:border-[#7fd0c4] hover:text-ink"
                onClick={onClose}
              >
                ✕
              </button>
              {sendBackOpen && (
                <div className="absolute right-0 top-full z-10 mt-2 w-72 rounded-[14px] border border-line bg-white p-3.5 shadow-[0_16px_44px_rgba(22,35,58,0.24)]">
                  <label className="block text-[10px] font-bold uppercase tracking-[.07em] text-ink-faint">
                    Note for the author (optional)
                    <textarea
                      rows={3}
                      className="mt-1 w-full resize-y rounded-lg border border-line px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-ink outline-none focus:border-[#0d9488]"
                      value={sendBackNote}
                      onChange={(e) => setSendBackNote(e.target.value)}
                    />
                  </label>
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-[10px] bg-[#fdecec] px-3.5 py-2 text-[12.5px] font-bold text-[#c53030] shadow-[inset_0_0_0_1px_#f3c4c4] disabled:opacity-60"
                      onClick={() => void sendBack()}
                    >
                      Send back
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          {error && <div className="mx-5 mb-2 rounded-lg bg-[#fdecec] px-3 py-2 text-xs text-[#c53030]">{error}</div>}
          <div className="flex-1 overflow-y-auto px-5 pb-5">
            <h4 className="mb-2 text-[10.5px] font-bold uppercase tracking-[.09em] text-ink-faint">
              Files on this draft
              {outsideCount > 0 && (
                <span className="ml-2 normal-case tracking-normal text-[#6d28d9]">
                  +{outsideCount} file{outsideCount === 1 ? '' : 's'} outside this skill
                </span>
              )}
            </h4>
            <div className="mb-4 flex flex-col gap-1.5">{branchFiles.map((f) => fileRow(f, 'branch'))}</div>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="font-mono text-[11px] text-ink-muted">{selected}</h4>
              <button
                type="button"
                className="rounded-lg bg-[#e0f8ee] px-3.5 py-1 text-[11.5px] font-bold text-[#0a8f60] shadow-[inset_0_0_0_1px_#a9e8cd] transition-transform hover:-translate-y-px"
                onClick={() => {
                  if (kbDirName) {
                    navigate(kbFileUrl(cr.branch, `${kbDirName}/${skill.path}/${selected}`));
                  }
                }}
              >
                Edit
              </button>
            </div>
            {lineView(diff, branchRaw, 'removed')}
          </div>
        </section>
      </div>
    </div>
  );
}
