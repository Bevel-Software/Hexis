import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useWorkspace } from '../state/workspace.context';
import { WorkspaceApiError } from '../services/workspace.api';
import { useGit } from '../../git/state/git.context';
import { readPersistedTabs } from '../utils/tab-persistence';
import {
  NODE_ID_LINK_RE,
  kbNodeUrl,
  fetchNodeWorkspacePath,
  fetchNodeId,
} from '../routing/kb-routes';
import { Banner, Button, Surface } from '../../../shared/components';
import { FileViewer } from './FileViewer';

type SyncError =
  | { kind: 'dirty'; current: string; target: string; dirtyFilenames: string[] }
  | { kind: 'file-missing'; path: string }
  | { kind: 'file-denied'; path: string }
  | { kind: 'file-load-failed'; path: string; message: string }
  | null;

export function FileRoute() {
  const params = useParams<{ branch: string; '*': string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const branchFromUrl = params.branch ? decodeURIComponent(params.branch) : '';
  // The trailing URL segment is either a node id (`/workspace/<branch>/<id>` —
  // the canonical node URL) or a file path (`/workspace/<branch>/<path>`). The id
  // grammar (lowercase, no slash/dot) is disjoint from a real workspace path, so
  // we can tell them apart up front. An id segment is resolved to its file path
  // below before driving the path-keyed tab system; a path segment that turns out
  // to be a node is canonicalized to its id URL (the redirect effect).
  const segment = params['*'] ?? '';
  const segmentIsId = NODE_ID_LINK_RE.test(segment);

  const workspace = useWorkspace();
  const git = useGit();
  const [error, setError] = useState<SyncError>(null);
  // True while a manual Retry is re-fetching, so the button can disable itself
  // and avoid stacking concurrent reads on a double-click.
  const [retrying, setRetrying] = useState(false);
  // Resolution of an id segment → its file path. `seg`+`branch` tag which segment
  // *and branch* the result is for so a stale async result — or a path resolved on
  // the previous branch after a branch switch keeps the same id segment — is
  // ignored; `path: null` means the id resolved to no readable node (a dangling
  // id, or a bare token that's actually a plain file — we then fall back to
  // loading the segment as a literal path).
  const [idResolved, setIdResolved] = useState<
    { seg: string; branch: string; path: string | null } | null
  >(null);

  const currentBranch = git.status?.branch ?? null;
  // In-memory edits the user typed into the renderer but hasn't saved yet,
  // computed across ALL open tabs. Without this, switching branches could
  // discard typed-but-unsaved bytes silently in any background tab.
  const hasUnsavedEdits = workspace.hasUnsavedFileChanges;

  // (workspaceId, branch) pair we've successfully hydrated tabs for. Reset to
  // null on branch switch so re-hydration fires for the new branch.
  const lastHydratedKeyRef = useRef<string | null>(null);

  const {
    workspaceId,
    openFilePath,
    addTab,
    hydrateTabs,
    setPersistenceBranch,
    dirtyTabFilenames,
  } = workspace;

  // The file path the tab system actually loads. For a path segment it's the
  // segment verbatim. For an id segment it's the resolved file path — empty
  // while the async resolve is in flight (so we don't briefly load the id token
  // as a path), falling back to the literal segment if the id resolved to no
  // node (the bare-token-is-really-a-file case).
  const pathFromUrl = segmentIsId
    ? idResolved && idResolved.seg === segment && idResolved.branch === branchFromUrl
      ? idResolved.path ?? segment
      : ''
    : segment;

  // ── Resolve an id segment → its file path ────────────────────────────────
  useEffect(() => {
    if (!segmentIsId) {
      setIdResolved(null);
      return;
    }
    if (!branchFromUrl) return;
    let cancelled = false;
    (async () => {
      const path = await fetchNodeWorkspacePath(branchFromUrl, segment);
      if (!cancelled) setIdResolved({ seg: segment, branch: branchFromUrl, path });
    })();
    return () => {
      cancelled = true;
    };
  }, [segmentIsId, segment, branchFromUrl]);

  // ── Canonicalize a path URL → the node's id URL ──────────────────────────
  // Once the file is the active tab, look up its node id and replace the path
  // URL with `/workspace/<branch>/<id>`. Non-node files (no id) stay path-based.
  // Guarded by `segmentIsId` so an already-canonical id URL no-ops and this can't
  // ping-pong; gated on `openFilePath === segment` so the subsequent id→path
  // load reuses the already-open tab instead of racing a second fetch.
  useEffect(() => {
    if (segmentIsId || !segment || !branchFromUrl) return;
    if (openFilePath !== segment) return;
    let cancelled = false;
    (async () => {
      const nodeId = await fetchNodeId(branchFromUrl, segment);
      if (!cancelled && nodeId) {
        navigate(kbNodeUrl(branchFromUrl, nodeId) + location.hash, { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [segmentIsId, segment, branchFromUrl, openFilePath, location.hash, navigate]);

  // ── Branch sync + hydrate + URL → state (forward direction) ──────────────

  useEffect(() => {
    if (!workspaceId) return;
    if (!branchFromUrl) return;

    let cancelled = false;
    const branchKnown = currentBranch !== null;
    const branchMatches = branchKnown && currentBranch === branchFromUrl;

    (async () => {
      // 1) URL points at a different branch than the workspace currently
      //    backing this route. Under the per-branch workspace model
      //    (`workspaces/<encodeURIComponent(branch)>/`), the "switch" is
      //    purely a workspace re-bootstrap to the new branch's clone — no
      //    git checkout, no server round-trip beyond cloning if needed.
      //    Setting `persistenceBranch` is what drives that bootstrap (see
      //    `useWorkspaceState`); when it resolves, `workspaceId` changes,
      //    `useGitState` re-fetches status against the new workspace, and
      //    this effect re-runs with `branchMatches === true` to proceed to
      //    the hydrate step.
      //
      //    The ONLY gate is in-memory tab dirtiness — typed-but-not-saved
      //    bytes in an open tab haven't reached the lock-release commit
      //    yet, and re-bootstrapping would discard them. Git working-tree
      //    state is NOT a gate here: per the save=share invariant the
      //    working tree is never dirty, and even if a bug leaves it dirty
      //    the user is moving to a different on-disk workspace anyway.
      if (branchKnown && !branchMatches) {
        if (hasUnsavedEdits) {
          setError({
            kind: 'dirty',
            current: currentBranch,
            target: branchFromUrl,
            dirtyFilenames: dirtyTabFilenames,
          });
          return;
        }
        setError(null);
        setPersistenceBranch(branchFromUrl);
        // Bail out and wait for the bootstrap to update workspaceId +
        // currentBranch. The hydration block below keys on
        // `(workspaceId, branch)` so it won't fire until both reflect the
        // new branch.
        return;
      }

      // 2) Hydrate tabs once per (workspaceId, branch) pair. This handles
      // both the persisted state and the URL deeplink in one pass — the URL
      // path (if any) is appended to the persisted paths and used as the
      // requested active path.
      const hydrationKey = `${workspaceId}.${branchFromUrl}`;
      if (lastHydratedKeyRef.current !== hydrationKey) {
        const persisted = readPersistedTabs(workspaceId, branchFromUrl);
        const paths = persisted.paths.slice();
        if (pathFromUrl && !paths.includes(pathFromUrl)) {
          paths.push(pathFromUrl);
        }
        const activePath = pathFromUrl || persisted.activePath;
        setPersistenceBranch(branchFromUrl);
        try {
          const { dropped, denied } = await hydrateTabs(paths, activePath);
          if (cancelled) return;
          lastHydratedKeyRef.current = hydrationKey;
          // If the URL deeplinked to a path that 404'd or 403'd, say why
          // nothing is showing. Persisted (non-deeplinked) tabs that fell in
          // either bucket were silently auto-closed by hydrateTabs.
          if (pathFromUrl && denied.includes(pathFromUrl)) {
            setError({ kind: 'file-denied', path: pathFromUrl });
          } else if (pathFromUrl && dropped.includes(pathFromUrl)) {
            setError({ kind: 'file-missing', path: pathFromUrl });
          } else {
            setError(null);
          }
        } catch (err) {
          if (!cancelled) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            setError({ kind: 'file-load-failed', path: pathFromUrl, message });
          }
        }
        return;
      }

      // 3) URL → state delta (after hydrate; fires when the user navigates to
      // a different file within the same branch).
      if (pathFromUrl) {
        if (openFilePath !== pathFromUrl) {
          try {
            await addTab(pathFromUrl);
            if (!cancelled) setError(null);
          } catch (err) {
            if (cancelled) return;
            if (err instanceof WorkspaceApiError && err.status === 404) {
              setError({ kind: 'file-missing', path: pathFromUrl });
            } else if (err instanceof WorkspaceApiError && err.status === 403) {
              setError({ kind: 'file-denied', path: pathFromUrl });
            } else {
              const message = err instanceof Error ? err.message : 'Unknown error';
              setError({ kind: 'file-load-failed', path: pathFromUrl, message });
            }
          }
        } else if (!cancelled) {
          setError(null);
        }
      } else if (!cancelled) {
        // URL with no path = "no active tab"; tabs in the strip stay open.
        setError(null);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally omitted from the dependency list:
    //   - hydrateTabs, addTab, setPersistenceBranch — provided by useWorkspace,
    //     wrapped in useCallback in useWorkspaceState so their identities are
    //     stable across renders.
    //   - dirtyTabFilenames — only read inside the dirty-branch-switch error
    //     branch; we want the value at the moment of the URL/branch change,
    //     not to re-run this effect every time a tab's dirty flag toggles.
    // The effect's run-conditions are the URL inputs, workspace identity, and
    // the current-branch signal; adding the destructured callbacks would only
    // cause spurious re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    branchFromUrl,
    pathFromUrl,
    workspaceId,
    currentBranch,
    hasUnsavedEdits,
  ]);

  // Manual retry for a failed load. Re-runs `addTab`, which re-fetches the
  // file AND re-evaluates read access server-side — so a transient failure or a
  // since-granted permission recovers without a full page reload. On success
  // the error clears; on a fresh failure we re-surface the matching error.
  const retryLoad = async (path: string) => {
    if (!path || retrying) return;
    setRetrying(true);
    try {
      await addTab(path);
      setError(null);
    } catch (err) {
      if (err instanceof WorkspaceApiError && err.status === 404) {
        setError({ kind: 'file-missing', path });
      } else if (err instanceof WorkspaceApiError && err.status === 403) {
        setError({ kind: 'file-denied', path });
      } else {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError({ kind: 'file-load-failed', path, message });
      }
    } finally {
      setRetrying(false);
    }
  };

  // No state→URL effect. The URL is the single authority for "what's active",
  // and only one direction of sync runs at a time:
  //   - User clicks a tab in EditorTabs        → useFileNav.openFile(path)  → URL changes → URL→state activates
  //   - User closes a tab in EditorTabs        → workspace.closeTab(tab); EditorTabs explicitly navigates after, using closeTab's returned newActivePath
  //   - Tree click in FileExplorer             → useFileNav.openFile(path)  → URL changes → URL→state activates
  //   - URL deeplink / hydrate                 → URL→state addTab activates
  // A reactive state→URL effect was tried earlier and caused an oscillation:
  // URL change → effect fires with stale activeTab in closure → navigates
  // back to the old path → URL→state catches up state → state→URL fires
  // again with the now-stale OTHER value → ping-pong.

  if (error?.kind === 'dirty') {
    return (
      <ErrorScreen title="Save your changes before opening this link">
        <p className="text-ui text-ink-muted">
          This link is on{' '}
          <span className="font-mono text-ink">{error.target}</span>, but you have
          unsaved changes on{' '}
          <span className="font-mono text-ink">{error.current}</span>. Save the
          files below first (Ctrl/Cmd+S, or click <span className="font-medium">Save</span>{' '}
          in the editor toolbar). That releases the lock and auto-commits and auto-pushes
          your changes: then this link will open.
        </p>
        {error.dirtyFilenames.length > 0 && (
          <Surface tone="sunken" radius="md" elevation="none" className="px-3 py-2 text-left text-detail text-ink">
            <div className="mb-1 font-medium text-ink">Unsaved files:</div>
            <ul className="list-disc space-y-0.5 pl-5">
              {error.dirtyFilenames.map((name) => (
                <li key={name} className="font-mono">{name}</li>
              ))}
            </ul>
          </Surface>
        )}
      </ErrorScreen>
    );
  }

  if (error?.kind === 'file-missing') {
    return (
      <ErrorScreen title="File not found">
        <p className="text-ui text-ink-muted">
          <span className="font-mono text-ink">{error.path}</span> doesn't exist on{' '}
          <span className="font-mono text-ink">{branchFromUrl}</span>.
        </p>
        <p className="text-meta text-ink-faint">
          It may have been renamed or removed, or this link may be from a different branch.
        </p>
      </ErrorScreen>
    );
  }

  if (error?.kind === 'file-denied') {
    const denyName = error.path.slice(error.path.lastIndexOf('/') + 1);
    return (
      <ErrorScreen title={"You don't have access to this file"} role="alert">
        {/* `note`, not `alert` — `ErrorScreen` already carries the alert on
            the box this sits inside, and two nested live regions announce the
            same sentence twice. This one is here for its `danger` tone. */}
        <Banner role="note" tone="danger" className="text-left">
          <span className="font-mono">{denyName}</span> is restricted. Ask an owner to grant
          you read access.
        </Banner>
        {/* Retry re-runs addTab, which re-checks access server-side — a user
            who was just granted access recovers in place. No tab exists for
            the denied file (denied tabs auto-close). */}
        <Button onClick={() => retryLoad(error.path)} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      </ErrorScreen>
    );
  }

  if (error?.kind === 'file-load-failed') {
    return (
      <ErrorScreen title="Couldn't load this file">
        <p className="text-ui text-ink-muted">
          Something went wrong reading{' '}
          <span className="font-mono text-ink">{error.path}</span>.
        </p>
        <p className="font-mono text-meta text-ink-faint">{error.message}</p>
        {/* Only offer Retry when we have a concrete file to re-fetch. A hydrate
            failure with no deeplinked path leaves `error.path` empty, and
            `retryLoad('')` is a no-op — so the button would be dead. */}
        {error.path && (
          <Button onClick={() => retryLoad(error.path)} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        )}
      </ErrorScreen>
    );
  }

  return <FileViewer />;
}

/**
 * One frame for the four full-screen states this route can end in.
 *
 * They said the same thing four different ways before — four copies of the
 * centring, four hand-rolled buttons, four type scales. Every sentence they
 * carried is preserved verbatim, including the dirty-branch explanation;
 * only the chrome is shared.
 */
function ErrorScreen({
  title,
  role,
  children,
}: {
  title: string;
  role?: 'alert';
  children: ReactNode;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-canvas px-6">
      <div role={role} className="max-w-md space-y-3 text-center">
        <h2 className="text-head text-ink">{title}</h2>
        {children}
      </div>
    </div>
  );
}
