import { useCallback, useState } from 'react';
import { CloudOff, GitMerge } from 'lucide-react';
import { useEventBusSubscription } from '../../workflow/hooks/useEventBusSubscription';
import { canonicalizeWorkspaceId } from '../../workflow/state/event-bus.context';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useFileNav } from '../../workspace/routing/kb-routes';

/**
 * The files a remote sync could not reconcile, each a link that opens it.
 * Its own component so the navigation hook is only mounted for the conflict
 * case — the push-failure banner has nothing to open.
 */
function ConflictFiles({ paths }: { paths: string[] }) {
  const { kbDirName } = useWorkspace();
  const { openWorkspacePath } = useFileNav();
  return (
    <ul className="mt-1 ml-5 flex flex-wrap gap-x-3 gap-y-0.5">
      {paths.map((p) => (
        <li key={p}>
          <button
            type="button"
            className="font-mono underline underline-offset-2 hover:text-ink"
            onClick={() => openWorkspacePath(`${kbDirName}/${p}`)}
          >
            {p}
          </button>
        </li>
      ))}
    </ul>
  );
}

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
  // One record PER workspace, keyed by canonical id. FileViewer is mounted at
  // a catch-all route and is NOT keyed by workspace, so this component
  // survives every branch switch: a single record would let branch B's
  // failure overwrite branch A's, hiding A's unresolved state on return. The
  // render gate below shows only the focused workspace's record.
  //
  // Known limit, accepted deliberately: SSE events are focus-scoped, so a
  // recovery that happens while the user is on another branch never arrives —
  // a retained record can be stale on return until that branch's next push
  // settles it (failures re-emit on every attempt, recoveries on the next
  // transition). The alternative — clearing on switch — hides real, still-
  // broken state, which is the exact failure mode this PR exists to fix.
  const [failures, setFailures] = useState<
    ReadonlyMap<string, { branch: string; reason: string; conflictedPaths?: string[] }>
  >(new Map());

  useEventBusSubscription(
    'git-sync-failed',
    useCallback(
      (e) => {
        // The bus already filters to the focused workspace, but a focus change
        // races with in-flight events — checking here keeps another branch's
        // failure from being recorded under this one's key.
        if (!canonId || canonicalizeWorkspaceId(e.workspaceId) !== canonId) return;
        setFailures((prev) =>
          new Map(prev).set(canonId, {
            branch: e.branch,
            reason: e.reason,
            conflictedPaths: e.conflictedPaths,
          }),
        );
      },
      [canonId],
    ),
  );

  useEventBusSubscription(
    'git-sync-recovered',
    useCallback(
      (e) => {
        if (!canonId || canonicalizeWorkspaceId(e.workspaceId) !== canonId) return;
        setFailures((prev) => {
          if (!prev.has(canonId)) return prev;
          const next = new Map(prev);
          next.delete(canonId);
          return next;
        });
      },
      [canonId],
    ),
  );

  const failure = canonId ? failures.get(canonId) : undefined;
  if (!failure) return null;

  // A remote-sync CONFLICT is the one failure an author can act on, not only
  // an operator: the same file changed here and on the git host. Automatic
  // recovery is already running; if it does not clear, the person decides.
  // Different copy, and the files themselves, each a link.
  if (failure.conflictedPaths && failure.conflictedPaths.length > 0) {
    return (
      <div
        role="alert"
        className="px-3 py-1.5 bg-sunken border-b border-line text-xs text-ink shrink-0"
      >
        <div className="flex items-center gap-2">
          <GitMerge size={13} className="shrink-0" />
          <span className="flex-1">
            <span className="font-mono font-semibold">{failure.branch}</span> isn’t in sync with
            the git repository yet: these files were changed both here and there. Hexis is trying
            to reconcile them. If this notice stays, open each one, keep the content you want, and
            save.
          </span>
        </div>
        <ConflictFiles paths={failure.conflictedPaths} />
      </div>
    );
  }

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
