import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, GitBranch, Plus, Lock, Check, GitPullRequest, Trash2, Loader2 } from 'lucide-react';
import { protectedBranchDisplayName, branchAuthorLocalpart, isBranchAuthoredBy, DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { useGit } from '../state/git.context';
import { parseGitError, type GitErrorInfo } from '../services/error-messages';
import { useAuth } from '../../auth/state/auth.context';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { kbFileUrl, KB_ROUTE_PREFIX } from '../../workspace/routing/kb-routes';
import { useCrCreationPort } from '../../../core/registry';
import { fetchFileAccess } from '../../access/api';

/**
 * Convert a free-text "what are you changing?" answer into a branch name slug.
 * Non-technical users type a sentence; we kebab-case it and prefix the user's
 * email local-part so the name still matches the documented convention.
 */
function slugifyDraftName(email: string, text: string): string {
  // `branchAuthorLocalpart` returns null for missing / unsanitizable emails;
  // the UI keeps a friendly `user` placeholder so the create form never blocks
  // on a malformed identity. Authorship checks elsewhere use the strict
  // helper and refuse delete when localpart is null.
  const localPart = branchAuthorLocalpart(email) ?? 'user';
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${localPart}/${slug || 'draft'}`;
}

/**
 * Place the branch dropdown just below its trigger. Coordinates are
 * viewport-fixed because the panel is portaled to <body> (so the toolbar's
 * mobile `overflow` row can't clip it).
 *
 * The width is returned alongside the coordinates rather than fixed in the
 * class list: on a phone narrower than the preferred 400px, clamping `left`
 * alone would still push the right edge off screen, so the panel shrinks to
 * whatever the viewport leaves between the two margins and `left` is clamped
 * against that same width.
 */
function computePanelPosition(triggerRect: DOMRect): {
  top: number;
  left: number;
  width: number;
} {
  const PREFERRED_WIDTH = 400;
  const MARGIN = 8; // min gap kept from the viewport edge
  const GAP = 4; // vertical gap below the trigger (matches the old top-8)
  const width = Math.min(PREFERRED_WIDTH, window.innerWidth - MARGIN * 2);
  const maxLeft = window.innerWidth - width - MARGIN;
  const left = Math.max(MARGIN, Math.min(triggerRect.left, maxLeft));
  return { top: triggerRect.bottom + GAP, left, width };
}

/**
 * The toolbar's branch picker: which shared draft you are on, and every way to
 * leave it — switch, create, propose as a change request, delete.
 *
 * An enterprise contribution rather than core furniture, so it arrives through
 * the registry's toolbar-item slot and the core build simply has no branch
 * control.
 */
export function BranchSwitcher() {
  const git = useGit();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { openFilePath, workspaceId } = useWorkspace();
  const crPort = useCrCreationPort();
  // True iff the current user is an admin per the active workspace's
  // `roles.yaml`. We piggy-back on the existing per-file access endpoint —
  // `canWrite` on `roles.yaml` already encodes "is admin" in the backend's
  // access model (only admins can rotate that file). Saves us from adding a
  // dedicated `/access/me` route just for this affordance. Defaults to
  // `false` while the fetch is in flight; the backend gate is authoritative
  // anyway, so a brief false-negative just means the delete button appears
  // a moment later.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    // No workspace → nothing to fetch and no admin-only affordance to render
    // (the branch list is empty too, so canDelete has no rows to apply to).
    // Skip resetting state — the next mount with a real workspaceId fetches
    // fresh, so a stale `true` can't cross a workspace boundary.
    if (!workspaceId) return;
    let cancelled = false;
    fetchFileAccess(workspaceId, 'roles.yaml')
      .then((r) => {
        if (!cancelled) setIsAdmin(r.canWrite);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [error, setError] = useState<GitErrorInfo | null>(null);
  // Fixed-viewport coordinates for the portaled dropdown panel. `null` until the
  // menu is first opened, then recomputed from the trigger's bounding rect on
  // every open. The panel is portaled to `document.body` so the toolbar's mobile
  // second row (`overflow-x-auto`/`overflow-y-hidden`) can't clip it — an inline
  // absolutely-positioned child can't escape an `overflow-x-auto` ancestor.
  const [panelPos, setPanelPos] = useState<ReturnType<
    typeof computePanelPosition
  > | null>(null);
  // Derived from URL: branch the route is pointing at. Used to label the
  // picker "Switching to X…" while the per-branch workspace bootstrap is
  // resolving in the background. Under the per-branch workspace model the
  // "switch" is purely the workspace re-bootstrap — there's no git op to
  // track an in-flight flag on, so we infer mid-switch from the URL-vs-status
  // mismatch directly. When the bootstrap completes, useGitState refreshes
  // status against the new workspaceId, status.branch flips to urlBranch,
  // and this falls back to null.
  const urlBranch = useMemo(() => {
    const prefix = `${KB_ROUTE_PREFIX}/`;
    if (!location.pathname.startsWith(prefix)) return null;
    const rest = location.pathname.slice(prefix.length);
    const slash = rest.indexOf('/');
    const branchPart = slash === -1 ? rest : rest.slice(0, slash);
    return branchPart ? decodeURIComponent(branchPart) : null;
  }, [location.pathname]);
  const switchingTo =
    urlBranch && git.status?.branch && urlBranch !== git.status.branch
      ? urlBranch
      : null;
  // When the user clicks "Propose this draft as a change request into…" we
  // swap the dropdown into a target-picker view. The PR only fires once they
  // pick a base branch from the list.
  const [choosingTarget, setChoosingTarget] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // The dropdown is portaled to `document.body`, so it's no longer a DOM
  // descendant of `ref`. The click-outside handler needs this second ref to
  // tell a click inside the panel from a click away from it.
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // The panel is portaled out of `ref`, so a click inside it would
      // otherwise read as "outside" and close the menu on the first mousedown.
      if (!ref.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
        setCreating(false);
        setChoosingTarget(false);
        setError(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // While the menu is open, re-anchor the portaled panel to the trigger on
  // resize (phone rotation) or scroll. Subscribe-only effect: setState runs
  // solely inside the external-event callback, never synchronously in the
  // effect body. The initial position is computed in the trigger's onClick.
  //
  // Scrolls *inside* the panel (the branch list, the target picker) bubble
  // up to this capture-phase listener but don't move the trigger, so skip
  // those — otherwise every wheel tick inside the dropdown forces a
  // getBoundingClientRect + setState round trip.
  useEffect(() => {
    if (!open) return;
    const reposition = (e?: Event) => {
      if (e && panelRef.current?.contains(e.target as Node)) return;
      const r = ref.current?.getBoundingClientRect();
      if (r) setPanelPos(computePanelPosition(r));
    };
    const onResize = () => reposition();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  const branch = git.status?.branch ?? '…';
  // Under the per-branch workspace model the workspace IS the current branch.
  // Derive "is this the row I'm on?" from `git.status.branch` instead of a
  // `BranchInfo.isCurrent` flag (which no longer exists — see
  // packages/shared/src/git/types.ts).
  const isCurrentBranch = (b: { name: string }) => b.name === git.status?.branch;
  const currentBranch = git.branches.find(isCurrentBranch);
  // Tooltip for the button needs to match what the user is actually on — on a
  // protected branch (Current/Target company state) calling it "your active
  // shared draft" is wrong, it's the official version everyone sees.
  const branchLabel = (() => {
    if (switchingTo) return `Switching to ${switchingTo}…`;
    const protectedName = protectedBranchDisplayName(git.status?.branch);
    if (protectedName) return `${protectedName} (official version)`;
    return 'Your active shared draft';
  })();
  // With auto-commit-and-push on lock release there is no dirty tree to gate
  // on — a draft is always ready to propose. The only gate left is "not a
  // protected branch", which the share flow enforces server-side too.
  const canOpenPr = !!currentBranch && !currentBranch.isProtected;

  async function doDelete(name: string, hasRemote: boolean) {
    // Two reasons a branch reaches doDelete: (1) it's an orphan with no
    // remote counterpart (PR merged + remote head pruned — tidy-up, no
    // confirm needed), or (2) it's a draft authored by the current user
    // who wants to discard it. Case 2 is destructive for the whole team
    // (the remote ref goes away for everyone), so confirm explicitly.
    if (hasRemote) {
      const ok = window.confirm(
        `Delete shared draft "${name}"? This removes it from the remote for everyone.`,
      );
      if (!ok) return;
    }
    try {
      await git.deleteBranch(name);
    } catch (err) {
      setError(parseGitError(err));
    }
  }

  function doSwitch(name: string) {
    // No-op when the user clicks the branch they're already on — otherwise a dirty
    // tree would pop the commit-first dialog for a switch that has nothing to do.
    if (name === git.status?.branch) {
      setOpen(false);
      return;
    }
    // Close the dropdown + lock the top button immediately so the UI doesn't
    // leave the menu open while the switch is in flight.
    setOpen(false);
    setCreating(false);
    setChoosingTarget(false);
    setError(null);

    // No dirty-tree pre-flight — lock release auto-commits any pending
    // edits and pushes them. FileRoute owns the actual switch; we just
    // declare intent by changing the URL.
    navigate(kbFileUrl(name, openFilePath ?? ''));
  }

  async function doCreate() {
    const text = newBranchName.trim();
    if (!text) return;
    const name = user?.email ? slugifyDraftName(user.email, text) : text;
    try {
      // Create the branch server-side on the current workspace's clone, then
      // navigate to the new branch's URL. The URL change triggers the
      // per-branch workspace bootstrap, which clones (or fetches) the new
      // branch into its own workspace dir. No explicit "switch" step.
      await git.createBranch(name);
      setNewBranchName('');
      setCreating(false);
      setOpen(false);
      navigate(kbFileUrl(name, openFilePath ?? ''));
    } catch (err) {
      setError(parseGitError(err));
    }
  }

  function doOpenPr(base: string) {
    if (!currentBranch) return;
    // Hand off to the registered change-request port. The enterprise registry
    // routes this to the chat agent (cascade impact analysis, push if needed,
    // `gh pr create`, PR-list refresh on turn end — see ChatAgentPortsProvider);
    // without an override, the core default opens the direct
    // OpenChangeRequestDialog against POST /api/workflow/change-requests.
    crPort?.start({
      workspaceId,
      branch: currentBranch.name,
      targetBranch: base,
    });
    setOpen(false);
    setChoosingTarget(false);
  }

  // Branches we can propose INTO — anything other than the current draft.
  // Protected branches rise to the top because they're the usual targets;
  // among the protected branches the default branch comes first because it's
  // the default destination for shared drafts (other company states are updated
  // separately by leadership). Other drafts follow alphabetically.
  const targetBranches = git.branches
    .filter((b) => !isCurrentBranch(b))
    .sort((a, b) => {
      if (a.isProtected !== b.isProtected) return a.isProtected ? -1 : 1;
      if (a.isProtected && b.isProtected) {
        if (a.name === DEFAULT_BRANCH) return -1;
        if (b.name === DEFAULT_BRANCH) return 1;
      }
      return a.name.localeCompare(b.name);
    });

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            // Fire-and-forget a refresh on open so branches created/deleted in
            // other workspaces surface without the user waiting for a poll.
            // `fresh: true` forces a server-side `git fetch --prune`, bypassing
            // the implicit-fetch TTL, so a draft another workspace just deleted
            // is pruned now rather than lingering until the TTL lapses. The
            // cached list renders immediately; the refreshed list lands async.
            void git.refreshBranches({ fresh: true });
            // Measure the trigger now — in an event handler the button is on
            // screen, and this setState batches with setOpen so the portal's
            // first paint is already correctly positioned.
            const r = ref.current?.getBoundingClientRect();
            if (r) setPanelPos(computePanelPosition(r));
            setOpen(true);
          }
          setError(null);
        }}
        className="flex items-center gap-1.5 px-2 py-1 text-xs rounded hover:bg-hover text-ink disabled:opacity-60 disabled:cursor-not-allowed"
        title={branchLabel}
        // Stay clickable mid-switch so the user can re-pick a branch — the
        // switch is just URL navigation and re-navigating cancels cleanly.
        // Only disabled before the very first status load, when there's no
        // branch name to show yet.
        disabled={git.availability === 'loading' && !git.status}
      >
        {switchingTo ? (
          <Loader2 size={13} className="animate-spin text-ink-muted" />
        ) : (
          <GitBranch size={13} />
        )}
        <span className="max-w-[160px] truncate">
          {switchingTo ?? branch}
        </span>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && panelPos && createPortal(
        <div
          ref={panelRef}
          className="fixed z-50 bg-sunken border border-line-strong rounded-lg shadow-xl overflow-hidden"
          style={{ top: panelPos.top, left: panelPos.left, width: panelPos.width }}
        >
          {!creating && !choosingTarget && (
            <>
              <button
                className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm text-ink hover:bg-hover"
                onClick={() => setCreating(true)}
              >
                <Plus size={14} />
                Start a shared draft…
              </button>
              <button
                className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm text-ink hover:bg-hover border-b border-line-strong disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => setChoosingTarget(true)}
                disabled={!canOpenPr}
                title={
                  !currentBranch
                    ? 'No draft selected'
                    : currentBranch.isProtected
                      ? "You can't propose changes from an official version — switch to a draft first"
                      : 'Pick where this change request should land'
                }
              >
                <GitPullRequest size={14} />
                Propose this draft as a change request into…
              </button>
            </>
          )}

          {choosingTarget && (
            <div className="border-b border-line-strong">
              <div className="flex items-center justify-between px-3 pt-2 pb-1">
                <span className="text-[11px] text-ink-muted uppercase tracking-wide">
                  Apply draft to…
                </span>
                <button
                  className="text-[11px] text-ink-muted hover:text-ink"
                  onClick={() => setChoosingTarget(false)}
                >
                  Cancel
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {targetBranches.length === 0 && (
                  <div className="px-3 py-2 text-xs text-ink-muted">
                    No other branches to target.
                  </div>
                )}
                {targetBranches.map((b) => {
                  const displayName = protectedBranchDisplayName(b.name);
                  // Default destination for shared drafts: visually distinguish
                  // the default branch so users see the recommended path without
                  // having to read the slug. Others stay available, just quieter.
                  const isDefaultTarget = b.name === DEFAULT_BRANCH;
                  return (
                    <button
                      key={b.name}
                      onClick={() => doOpenPr(b.name)}
                      className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm ${
                        isDefaultTarget
                          ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                          : 'text-ink hover:bg-hover'
                      }`}
                    >
                      {b.isProtected && <Lock size={11} className="text-ink-muted" />}
                      {displayName ? (
                        <span className="truncate flex-1" title={b.name}>
                          {displayName}
                          {isDefaultTarget && (
                            <span className="ml-1.5 text-[10px] uppercase tracking-wide text-emerald-600">
                              default
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="truncate flex-1" title={b.name}>{b.name}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {creating && (
            <div className="px-3 py-2 border-b border-line-strong space-y-2">
              <div className="text-[11px] text-ink-muted">What are you changing?</div>
              <input
                autoFocus
                type="text"
                placeholder="e.g. Add owner to Checkout process"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') doCreate();
                  if (e.key === 'Escape') {
                    setCreating(false);
                    setNewBranchName('');
                  }
                }}
                className="w-full bg-white border border-line-strong rounded px-2 py-1 text-xs focus:outline-none focus:border-accent"
              />
              <div className="flex justify-end gap-1">
                <button
                  onClick={() => {
                    setCreating(false);
                    setNewBranchName('');
                  }}
                  className="px-2 py-0.5 text-xs rounded hover:bg-hover text-ink"
                >
                  Cancel
                </button>
                <button
                  onClick={doCreate}
                  disabled={!newBranchName.trim()}
                  className="px-2 py-0.5 text-xs rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
                >
                  Start draft
                </button>
              </div>
            </div>
          )}

          <div className="max-h-64 overflow-y-auto">
            {git.branches.length === 0 && (
              <div className="px-3 py-2 text-xs text-ink-muted">No drafts yet.</div>
            )}
            {git.branches.map((b) => {
              const current = isCurrentBranch(b);
              // Three delete cases reach the picker:
              //   1. Orphan — `hasRemote === false`. A branch whose remote
              //      counterpart was pruned (typically PR merged + GitHub
              //      auto-deletes the head). Pure local tidy-up, anyone can
              //      do it because there's nothing left on origin to push
              //      the delete to.
              //   2. Authored draft — branch matches `<my-localpart>/...`.
              //      The current user owns it; delete pushes the remote
              //      ref away too so the discard is total. Confirm dialog
              //      lives in doDelete because this is destructive for
              //      every teammate who could see the draft.
              //   3. Admin cleanup — current user is admin per `roles.yaml`.
              //      Admins can delete any non-protected, non-current branch,
              //      including teammates' drafts AND unprefixed CLI branches
              //      that have no author. Backend gate at
              //      `GitService.deleteBranch` is the authoritative check.
              // The current branch and protected branches are never
              // deletable (regression-guarded server-side too).
              const isAuthoredByMe = isBranchAuthoredBy(b.name, user?.email);
              const isOrphan = b.hasRemote === false;
              const canDelete =
                !b.isProtected && !current && (isOrphan || isAuthoredByMe || isAdmin);
              const deleteTitle = isOrphan
                ? 'Delete this draft (no longer shared)'
                : `Delete shared draft "${b.name}" — removes it for everyone`;
              return (
                <div
                  key={b.name}
                  className={`flex items-stretch w-full text-sm group ${
                    current
                      ? 'bg-line-strong text-ink'
                      : 'text-ink hover:bg-hover'
                  }`}
                >
                  <button
                    onClick={() => doSwitch(b.name)}
                    disabled={current}
                    aria-current={current ? 'true' : undefined}
                    className={`flex items-center gap-2 flex-1 min-w-0 text-left px-3 py-1.5 ${
                      current ? 'cursor-default' : ''
                    }`}
                  >
                    {current ? <Check size={12} /> : <span className="w-3" />}
                    {b.isProtected && <Lock size={11} className="text-ink-muted" />}
                    <span className="truncate flex-1" title={b.name}>{b.name}</span>
                  </button>
                  {canDelete && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        doDelete(b.name, !isOrphan);
                      }}
                      title={deleteTitle}
                      aria-label={deleteTitle}
                      className="px-2 text-ink-muted hover:text-red-600 hover:bg-hover opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {error && (
            <div
              role="alert"
              className="px-3 py-2 text-xs text-red-600 border-t border-line-strong"
            >
              {error.message}
            </div>
          )}
        </div>,
        document.body,
      )}

    </div>
  );
}
