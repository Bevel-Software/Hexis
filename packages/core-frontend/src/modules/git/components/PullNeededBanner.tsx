import { useState } from 'react';
import { GitMerge } from 'lucide-react';
import { isProtectedBranch } from '@bevel-software/platform-shared';
import { useGit } from '../state/git.context';
import { useAutoUpdate } from '../state/auto-update.context';
import { useCrCreationPort } from '../../../core/registry';
import { PR_STALE_EVENT } from '../../../core/events';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { sanitizeErrorText } from '../services/error-messages';

/**
 * Classify a pull failure into a short, user-safe phrase. Returned strings
 * flow through the change-request port's `resolvePullIssue` (the enterprise
 * registry splices them into the chat composer, where the user sees them), so
 * the labels must not leak git vocabulary — no "merge conflict",
 * "uncommitted", "working tree", "stash", "HEAD". The agent's own prompt
 * knows the underlying mechanics; the user gets a workspace-level description
 * of what happened.
 */
function classifyPullFailure(error: unknown): string {
  const sanitized = sanitizeErrorText(error).toLowerCase();
  if (/\b(conflict|conflicts|merge conflict|would be overwritten)\b/.test(sanitized)) {
    return 'two versions of the same file need to be reconciled';
  }
  if (/\b(uncommitted|local changes|working tree|dirty|stash)\b/.test(sanitized)) {
    return 'there are local changes that need to be sorted out first';
  }
  if (
    /\b(network|auth|credential|permission denied|unauthorized|forbidden|timeout|timed out|could not resolve host|failed to connect|401|403)\b/.test(
      sanitized,
    )
  ) {
    return 'a connection or permission problem';
  }
  return 'something unexpected went wrong';
}

/**
 * Shown when the current branch is behind origin. On protected branches
 * (current-company-state / target-company-state) the API guards block local
 * commits, so when the working tree is clean a `git pull --rebase` is a
 * fast-forward — that's the path we optimise for. If the rebase is refused
 * (dirty tree from a mid-flow edit, or any non-FF situation a power user
 * created via the CLI), we surface the error inline AND hand the failure to
 * the change-request port so the agent can investigate. On feature branches
 * the user may have overlapping local work, so we skip the direct attempt
 * and hand off straight away. The banner auto-hides once
 * `unmergedFromUpstream` flips back to false.
 */
export function PullNeededBanner() {
  const git = useGit();
  const autoUpdate = useAutoUpdate();
  const workspace = useWorkspace();
  const crPort = useCrCreationPort();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (git.availability !== 'ready') return null;
  const status = git.status;
  if (!status?.unmergedFromUpstream) return null;

  // Captured for the handlers below — TS control-flow narrowing on `status`
  // doesn't survive into nested function declarations.
  const branchName = status.branch;
  const onProtectedBranch = isProtectedBranch(status.branch);
  const hasUnsavedEditorChanges = !!workspace.hasUnsavedFileChanges;
  // Under save=share the working tree is never dirty and there are no
  // mid-merge conflicts to gate on — the only thing that can still block
  // the auto-pull is in-memory tab edits the user hasn't saved yet.
  const autoEligible = onProtectedBranch && !hasUnsavedEditorChanges;
  const autoFailed = autoUpdate.status === 'failed' && autoUpdate.branch === status.branch;

  if (autoEligible && !autoFailed) return null;

  async function pullDirectly() {
    setError(null);
    setPending(true);
    try {
      // Pull is the only operation whose failure should hand off to the
      // agent — that's the user-visible action they clicked Retry on, and
      // a pull failure is the case where the agent has a real recovery
      // (resolve conflicts, switch branches, etc.) to attempt. Wrap it
      // alone so a transient post-pull refresh hiccup can't masquerade
      // as a pull failure and seed a misleading "I tried to bring in
      // teammate updates but it didn't go through" prompt.
      try {
        await git.pull();
      } catch (err) {
        const reason =
          err instanceof Error
            ? sanitizeErrorText(err) || 'Could not get updates.'
            : 'Could not get updates.';
        setError(reason);
        const seedReason = classifyPullFailure(err);
        // Hand off through the change-request port so the user always has a
        // path forward — the enterprise registry seeds the agent chat, where
        // the common rebase-refused case (dirty working tree from a mid-flow
        // agent edit) is exactly the kind of thing the agent can unblock.
        crPort?.resolvePullIssue?.({
          workspaceId: workspace.workspaceId,
          branch: branchName,
          kind: 'pull-failed',
          reason: seedReason,
        });
        return;
      }

      // Post-pull reconciliation. The working tree on disk just changed,
      // so refresh + bump so the explorer + open tabs don't show stale
      // bytes, and notify the PR list that its data may have moved.
      // Failures here do NOT roll back the pull or seed the agent — the
      // remote state already changed and a transient refresh hiccup is
      // a UI staleness issue, not a "couldn't update" failure.
      try {
        await workspace.refreshFileTree();
        // Invalidate cached tab content so every open tab re-reads from disk
        // on next activation; the active tab refetches eagerly. If a tab's
        // path vanished underneath the pull, the eager refetch's 404 handler
        // drops that tab automatically.
        workspace.bumpFsRevision();
        // Tell the PR list its data may have moved (new requests from
        // teammates, or merges they completed). Same event chat-end /
        // merge / share fire.
        window.dispatchEvent(new CustomEvent(PR_STALE_EVENT));
      } catch (err) {
        const reason =
          err instanceof Error
            ? sanitizeErrorText(err) || 'Could not refresh after update.'
            : 'Could not refresh after update.';
        setError(reason);
        console.debug('[pull] post-pull refresh failed:', reason);
      }
    } finally {
      setPending(false);
    }
  }

  function askAgentToMerge() {
    crPort?.resolvePullIssue?.({
      workspaceId: workspace.workspaceId,
      branch: branchName,
      kind: 'behind',
    });
  }

  const showRetry = onProtectedBranch && autoFailed;
  // The assistant hand-off needs a registered pull-issue resolver (the
  // enterprise chat port); without one there's no agent to ask, so the
  // action hides and the banner stays informational.
  const showAssistantAction = !onProtectedBranch && !!crPort?.resolvePullIssue;
  const showAction = showRetry || showAssistantAction;
  const handleClick = showRetry ? pullDirectly : askAgentToMerge;
  const buttonLabel = pending ? 'Retrying…' : showRetry ? 'Retry' : 'Ask assistant';
  const message = autoFailed
    ? 'Couldn’t update automatically'
    : showAssistantAction
      ? 'Your draft is missing teammate updates'
      : 'Updates are waiting';
  // After save=share, the only thing that can keep auto-pull from running on
  // a protected branch is in-memory tab edits. The previous fallback referred
  // to "discard your local changes" — a dirty-tree / conflicted-paths exit
  // that's now structurally impossible. We render that guidance only when
  // there are unsaved tab edits, and otherwise leave it null.
  const guidance = autoFailed
    ? autoUpdate.reason
    : showAssistantAction
      ? null
      : hasUnsavedEditorChanges
        ? 'Finish or save your open file before updating.'
        : null;

  return (
    <div
      role="status"
      className="px-3 py-1.5 bg-sky-50 border-b border-sky-200 text-xs text-sky-800 shrink-0"
    >
      <div className="flex items-center gap-2">
        <GitMerge size={13} className="shrink-0" />
        <span className="flex-1">
          {message} (<span className="font-mono font-semibold">{status.branch}</span>).
        </span>
        {showAction && (
          <button
            onClick={handleClick}
            disabled={pending}
            className="px-2 py-0.5 rounded bg-sky-600 hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium"
          >
            {buttonLabel}
          </button>
        )}
      </div>
      {guidance && (
        <div className="mt-1 ml-5 text-sky-700">
          {guidance}
        </div>
      )}
      {error && (
        <div role="alert" className="mt-1 ml-5 text-rose-700">
          {error}
        </div>
      )}
    </div>
  );
}
