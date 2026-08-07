import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_BRANCH,
  protectedBranchDisplayName,
} from '@bevel-software/platform-shared';
import { Dialog } from '../../../shared/components/Dialog';
import { useGit } from '../../git/state/git.context';
import { openChangeRequest } from '../services/pr-open.api';
import { PR_STALE_EVENT } from '../../../core/events';

interface Props {
  open: boolean;
  onClose(): void;
  /** The shared draft the change request is opened from. */
  sourceBranch: string;
  /** Preselected destination, when the caller already picked one. */
  initialTargetBranch?: string;
}

/**
 * Direct change-request creation — the core default behind the
 * change-request port. Collects a title / optional description / destination
 * and posts to the existing `POST /api/workflow/change-requests` endpoint.
 * Deployments with the chat module registered never see this dialog (their
 * registry routes "Propose changes" through the agent instead); it exists so
 * the core shell has a working proposal path on its own.
 *
 * Copy follows docs/glossary.md: "shared draft", "change request",
 * "apply to", protected branches shown via `protectedBranchDisplayName`.
 */
export function OpenChangeRequestDialog({
  open,
  onClose,
  sourceBranch,
  initialTargetBranch,
}: Props) {
  const git = useGit();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [targetBranch, setTargetBranch] = useState(
    initialTargetBranch ?? DEFAULT_BRANCH,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh form per open — a dismissed proposal shouldn't leak into the next.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setTargetBranch(initialTargetBranch ?? DEFAULT_BRANCH);
    setError(null);
  }, [open, initialTargetBranch]);

  // Destinations: anything but the draft itself. Protected branches first
  // (default branch leading) — same ordering as the BranchSwitcher's target
  // picker so both surfaces read identically.
  const targets = useMemo(
    () =>
      git.branches
        .filter((b) => b.name !== sourceBranch)
        .sort((a, b) => {
          if (a.isProtected !== b.isProtected) return a.isProtected ? -1 : 1;
          if (a.isProtected && b.isProtected) {
            if (a.name === DEFAULT_BRANCH) return -1;
            if (b.name === DEFAULT_BRANCH) return 1;
          }
          return a.name.localeCompare(b.name);
        }),
    [git.branches, sourceBranch],
  );

  async function submit() {
    if (busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await openChangeRequest({
        sourceBranch,
        targetBranch,
        title: title.trim(),
        description: description.trim() || undefined,
      });
      // Same refresh signal every other CR-mutating surface fires — the
      // "Change requests for you" sidebar refetches immediately.
      window.dispatchEvent(new CustomEvent(PR_STALE_EVENT));
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't open the change request.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Propose changes"
      size="md"
      busy={busy}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded hover:bg-hover text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !title.trim()}
            className="px-3 py-1.5 text-xs rounded bg-emerald-700 hover:bg-emerald-600 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Opening…' : 'Open change request'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-xs text-ink-muted">
          Propose your shared draft{' '}
          <span className="font-mono font-medium text-ink">
            {sourceBranch}
          </span>{' '}
          as a change request. Approvers can review it before it's applied.
        </p>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink">
            What did you change?
          </span>
          <input
            autoFocus
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder="e.g. Add owner to Checkout process"
            className="w-full bg-white border border-line-strong rounded px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink">
            Anything approvers should know?{' '}
            <span className="font-normal text-ink-muted">(optional)</span>
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full bg-white border border-line-strong rounded px-2 py-1.5 text-sm focus:outline-none focus:border-accent resize-y"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink">Apply to</span>
          <select
            value={targetBranch}
            onChange={(e) => setTargetBranch(e.target.value)}
            className="w-full bg-white border border-line-strong rounded px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
          >
            {targets.length === 0 && (
              <option value={targetBranch}>
                {protectedBranchDisplayName(targetBranch) ?? targetBranch}
              </option>
            )}
            {targets.map((b) => (
              <option key={b.name} value={b.name}>
                {protectedBranchDisplayName(b.name) ?? b.name}
                {b.name === DEFAULT_BRANCH ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <div role="alert" className="text-xs text-red-600">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
