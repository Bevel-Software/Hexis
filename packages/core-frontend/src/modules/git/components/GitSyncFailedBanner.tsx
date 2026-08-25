import { useCallback, useState } from 'react';
import { CloudOff } from 'lucide-react';
import { useEventBusSubscription } from '../../workflow/hooks/useEventBusSubscription';
import { canonicalizeWorkspaceId } from '../../workflow/state/event-bus.context';
import { useWorkspace } from '../../workspace/state/workspace.context';

/**
 * Shown when a commit landed locally but could not be pushed to the remote.
 *
 * The save itself is fine and is NOT rolled back — the commit is on the
 * server's disk and the retry paths keep running — so this is a warning, not
 * an error state, and nothing here blocks the user. It exists because the
 * failure is otherwise completely invisible: pushes happen behind saves, the
 * one path that does surface an error only reaches a still-mounted editor, and
 * a deployment with a broken git credential therefore looks perfectly healthy
 * while every commit stacks up locally. One self-hosted install ran two days
 * and 136 commits that way.
 *
 * Deliberately not addressed to the author: every cause of a failing push —
 * an expired token, a revoked repo grant, an unreachable host — is an operator
 * concern, and there is nothing the person writing a page can do about it. So
 * the copy tells them their work is safe and points whoever can act at the
 * logs, rather than explaining git.
 *
 * Clears on `git-sync-recovered`, which the backend emits when a push
 * succeeds after failing. No dismiss control, same as `PullNeededBanner`: the
 * condition is real until the server says otherwise, and the next failing save
 * would re-raise it anyway.
 */
export function GitSyncFailedBanner() {
  const workspace = useWorkspace();
  const workspaceId = workspace.workspaceId;
  // Local state (`workspace.id`) is URL-encoded (`user%2Ffeat`); event ids
  // arrive URL-decoded (`user/feat`, Express auto-decodes `req.params.id`).
  // Comparing them raw drops every event on a slashed feature branch — the
  // exact silent-failure symptom this banner exists to surface — so both
  // sides are canonicalised, the same way every other SSE consumer does.
  const canonId = workspaceId ? canonicalizeWorkspaceId(workspaceId) : null;
  // The failure remembers WHICH workspace it belongs to. FileViewer is
  // mounted at a catch-all route and is NOT keyed by workspace, so this
  // component survives a branch switch — without the ownership check below, a
  // failure from the branch just left would keep painting over the new one,
  // and no `git-sync-recovered` would ever arrive to clear it (the backend
  // only emits that on a real push transition of the OTHER workspace).
  const [failure, setFailure] = useState<{ forId: string; branch: string; reason: string } | null>(
    null,
  );

  useEventBusSubscription(
    'git-sync-failed',
    useCallback(
      (e) => {
        // The bus already filters to the focused workspace, but a focus change
        // races with in-flight events — checking here keeps another branch's
        // failure from painting a banner over this one.
        if (!canonId || canonicalizeWorkspaceId(e.workspaceId) !== canonId) return;
        setFailure({ forId: canonId, branch: e.branch, reason: e.reason });
      },
      [canonId],
    ),
  );

  useEventBusSubscription(
    'git-sync-recovered',
    useCallback(
      (e) => {
        if (!canonId || canonicalizeWorkspaceId(e.workspaceId) !== canonId) return;
        setFailure(null);
      },
      [canonId],
    ),
  );

  // Ownership gate rather than an effect-driven reset: a stale entry simply
  // stops rendering when the focus moves elsewhere, and (unlike wiping it)
  // still shows if the user returns to the failed branch — where the
  // condition is real until a recovery event or a successful push says
  // otherwise.
  if (!failure || failure.forId !== canonId) return null;

  return (
    <div
      role="alert"
      className="px-3 py-1.5 bg-sunken border-b border-line text-xs text-ink shrink-0"
    >
      <div className="flex items-center gap-2">
        <CloudOff size={13} className="shrink-0" />
        <span className="flex-1">
          Changes on <span className="font-mono font-semibold">{failure.branch}</span> aren’t
          reaching the remote repository. Your work is saved here — an administrator should check
          the server logs.
        </span>
      </div>
      <div className="mt-1 ml-5 text-ink-muted break-words">{failure.reason}</div>
    </div>
  );
}
