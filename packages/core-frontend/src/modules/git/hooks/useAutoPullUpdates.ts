import { useEffect, useRef, useState } from 'react';
import type { GitContextValue } from '../state/git.context';
import {
  IDLE_AUTO_UPDATE,
  type AutoUpdateState,
} from '../state/auto-update.context';
import type { WorkspaceContextValue } from '../../workspace/state/workspace.context';
import { sanitizeErrorText } from '../services/error-messages';
import { PR_STALE_EVENT } from '../../../core/events';

export function useAutoPullUpdates(
  git: GitContextValue,
  workspace: WorkspaceContextValue,
): AutoUpdateState {
  const attemptedKeyRef = useRef<string | null>(null);
  const [autoUpdate, setAutoUpdate] = useState<AutoUpdateState>(IDLE_AUTO_UPDATE);
  const { availability, status, pull } = git;
  const {
    workspaceId,
    hasUnsavedFileChanges,
    refreshFileTree,
    bumpFsRevision,
  } = workspace;

  useEffect(() => {
    if (!workspaceId || availability !== 'ready' || !status?.unmergedFromUpstream) {
      attemptedKeyRef.current = null;
      void Promise.resolve().then(() => setAutoUpdate(IDLE_AUTO_UPDATE));
      return;
    }

    // Auto-pull on EVERY branch (protected + feature) whenever we're
    // behind upstream and it's safe to touch. The old policy gated
    // this to protected branches only, on the theory that feature
    // branches were single-owner. Under the save=share workflow, multiple
    // users share the on-disk clone per branch, and an agent acting on a
    // user's behalf can advance origin between this client's saves — so
    // a feature branch silently falling behind is the same bug class as
    // a protected one. The only remaining guard is in-memory tab edits;
    // working-tree dirty state + mid-merge conflicts don't exist as
    // gating signals anymore (save=share rules them out).
    if (hasUnsavedFileChanges) {
      void Promise.resolve().then(() => setAutoUpdate(IDLE_AUTO_UPDATE));
      return;
    }

    const key = `${workspaceId}:${status.branch}`;
    if (attemptedKeyRef.current === key) return;
    attemptedKeyRef.current = key;

    let cancelled = false;

    void (async () => {
      setAutoUpdate({ status: 'updating', branch: status.branch, reason: null });

      // Only pull() failures should mark the whole auto-update as failed —
      // that's the user-visible status the banner reads to decide whether
      // to surface a Retry. A post-pull refresh hiccup is a UI staleness
      // issue, not an "update couldn't happen" failure (the merge already
      // landed on disk), and surfacing it as such would make the user
      // re-pull when there's nothing left to pull.
      try {
        await pull();
      } catch (err) {
        if (cancelled) return;
        const sanitizedReason = sanitizeErrorText(err) || 'Could not get updates.';
        setAutoUpdate({
          status: 'failed',
          branch: status.branch,
          reason: sanitizedReason,
        });
        // Log only the sanitized text — raw err.message can contain urls,
        // tokens, or local paths we just stripped from the user-facing reason.
        console.debug('[git] auto-pull skipped:', sanitizedReason, {
          branch: status.branch,
        });
        return;
      }
      if (cancelled) return;

      try {
        await refreshFileTree();
        if (cancelled) return;

        // Invalidate cached tab content so the active tab eagerly refetches
        // (and surfaces fresh bytes after the merge), and inactive tabs
        // re-read on next activation. If a tab's path vanished underneath
        // the pull, the eager refetch's 404 path drops that tab.
        bumpFsRevision();

        window.dispatchEvent(new CustomEvent(PR_STALE_EVENT));
      } catch (err) {
        if (cancelled) return;
        // Pull already landed — keep the auto-update marked idle so the
        // banner doesn't reappear with a misleading "couldn't update"
        // message. Just log so a misbehaving refresh shows up in console.
        console.debug(
          '[git] auto-pull post-refresh failed:',
          sanitizeErrorText(err) || String(err),
          { branch: status.branch },
        );
      }
      if (cancelled) return;
      setAutoUpdate(IDLE_AUTO_UPDATE);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    availability,
    status,
    pull,
    workspaceId,
    hasUnsavedFileChanges,
    refreshFileTree,
    bumpFsRevision,
  ]);

  return autoUpdate;
}
