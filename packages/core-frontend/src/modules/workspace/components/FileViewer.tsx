import { useMemo, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Check, XCircle, Lock, AlertTriangle, ArrowLeft, FileText, History } from 'lucide-react';
import type { FileTreeEntry, PullRequestSummary } from '@bevel-software/platform-shared';
import { useWorkspace } from '../state/workspace.context';
import { EditorTabs } from './EditorTabs';
import { KbPageHeader } from './KbPageHeader';
import { useOpenChangeRequests } from '../hooks/useOpenChangeRequests';
import { Banner, Button, IconButton, Surface } from '../../../shared/components';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { useGit } from '../../git/state/git.context';
import { LayoutContext } from '../../layout/state/layout.context';
import { useParams } from 'react-router-dom';
import { useCanonicalFileUrl, useFileNav } from '../routing/kb-routes';
import { PullNeededBanner } from '../../git/components/PullNeededBanner';
import { GitSyncFailedBanner } from '../../git/components/GitSyncFailedBanner';
import { useFileAccess } from '../../access/hooks/useFileAccess';
import { FileHistoryPanel } from '../../git/components/FileHistoryPanel';
import { FileComparisonPanel } from '../../git/components/FileComparisonPanel';
import {
  OPEN_COMPARISON_EVENT,
  type OpenComparisonDetail,
} from '../../../core/events';
import { useAppRegistry } from '../../../core/registry';
import { useFileLock } from '../../workflow/hooks/useFileLock';
import { LockApiError } from '../../workflow/services/lock.api';
import { useAuth } from '../../auth/state/auth.context';
import {
  knowledgeSuggestionBranchFor,
  proposeKnowledgeChange,
} from '../../change-requests/services/propose.api';
import {
  listMyChangeRequests,
  readFileOnBranch,
} from '../../change-requests/services/change-requests.api';
import { FileChangeBoxes } from '../../change-requests/components/FileChangeBoxes';
import { ChangeRequestDialog } from '../../change-requests/components/ChangeRequestDialog';
import { formatEligible } from '../../access/hooks/useFileAccess';
import { PR_STALE_EVENT } from '../../../core/events';
import { suggestedPages } from '../utils/fileTree';
import { getFileRenderer, getRendererLayout, isViewOnlyFile } from './renderers';
import { CanDownloadContext } from './renderers/DownloadFileButton';
import type { RendererSaveState } from './renderers';
import { KbDocumentShell } from './KbDocumentShell';
import { FilePaneCard } from './FilePaneCard';

/**
 * How many pages the empty viewer offers. Enough to look like a starting
 * point, few enough to read at a glance — a longer list is the file tree,
 * which is already on screen and better at being one.
 */
const SUGGESTION_LIMIT = 4;

/** What a page is called, without the extension the reader did not choose. */
function pageTitle(fileName: string): string {
  return fileName.replace(/\.(md|markdown)$/i, '');
}

/** The folder a page sits in, or '' for one that sits at a root. */
function parentFolder(relativePath: string): string {
  return relativePath.split('/').slice(-2, -1)[0] ?? '';
}

export function FileViewer() {
  const {
    workspaceId,
    kbDirName,
    fileTree,
    openFilePath,
    openFileContent,
    openFileSavedContent,
    setHasUnsavedFileChanges,
    setActiveTabContent,
    pendingFileContent,
    saveFile,
    fsRevision,
    acceptPendingContent,
    rejectPendingContent,
    addTab,
    reloadTabFromDisk,
  } = useWorkspace();
  const { fileViewerPanels, renderers } = useAppRegistry();
  const git = useGit();
  // Hiding the tree buys margin, not line length (proto:709), and the pane
  // controller is the only thing that knows whether it is hidden.
  //
  // Read straight off the context rather than through `useLayout`, which
  // THROWS when there is no provider. A gutter is cosmetic; it must not be
  // able to take the whole viewer down. There are two live cases with no
  // controller — a registry app mounted outside the pane layout, and every
  // unit test that renders FileViewer on its own — and in both the honest
  // answer is "the tree is not hidden".
  const layout = useContext(LayoutContext);
  const explorerHidden = layout?.isExplorerCollapsed ?? false;

  // File-lock integration (PLAN §2). One useFileLock per (branch, file)
  // the user has open. Acquired on first dirty edit, released when the
  // editor unmounts or switches files. The hook handles heartbeat and
  // autosave checkpoints internally.
  const currentBranch = git.status?.branch ?? null;
  // `openFileContentRef` pins the latest in-memory buffer so the lock
  // hook's autosave timer can read it without re-subscribing on every
  // keystroke.
  const openFileContentRef = useRef<string | null>(openFileContent);
  useEffect(() => { openFileContentRef.current = openFileContent; }, [openFileContent]);
  // Stable read of the active path for async handlers that need to check
  // whether the user switched files mid-await.
  const openFilePathRef = useRef<string | null>(openFilePath);
  useEffect(() => { openFilePathRef.current = openFilePath; }, [openFilePath]);
  const persistToDisk = useCallback(async (content: string) => {
    if (!openFilePath) return;
    await saveFile(openFilePath, content);
  }, [openFilePath, saveFile]);
  const auth = useAuth();
  const fileLock = useFileLock({
    workspaceId,
    branch: currentBranch,
    path: openFilePath,
    // Lets the hook filter out "lock held by me" responses during the
    // window where a previous tab's release is still in flight, so
    // switching away and back doesn't flicker a self-locked banner.
    currentUserId: auth.user?.id ?? null,
    readPendingContent: () => openFileContentRef.current,
    persistToDisk,
  });
  // Editability is governed by roles.yaml + access.md, but only on
  // protected branches — drafts are free-for-all and the hook returns
  // canWrite=true for them without a network call. The hook returns
  // `canWrite: null` while the lookup is in flight; we treat that as
  // "allow editing optimistically" so the editor doesn't flicker between
  // disabled / enabled. On a hard `canWrite === false`, the editor goes
  // read-only and a banner explains who can change the file.
  const access = useFileAccess(openFilePath, currentBranch);
  const accessRestricted = access.canWrite === false;
  // Keep the existing variable name so the rest of the file (legacy uses for
  // dirty-flag bookkeeping etc.) doesn't need to change.
  const onProtectedBranch = accessRestricted;
  // Registered auxiliary surfaces (e.g. the enterprise agent-review badge +
  // panel). Rendered on every return path exactly where the hard-mounted
  // review surface used to sit, inside this component's relative container so
  // absolutely-positioned panels anchor the same way.
  const registeredPanels = fileViewerPanels.map(({ id, Component }) => (
    <Component key={id} />
  ));
  // Registry renderer overrides win over the built-in extension map — the
  // enterprise registry swaps in its own `.html` renderer (vendored d3/mermaid
  // + KB graph client) this way.
  const Renderer = useMemo(() => {
    if (!openFilePath) return null;
    const ext = openFilePath.slice(openFilePath.lastIndexOf('.')).toLowerCase();
    const override = renderers.find((r) => r.extensions.includes(ext));
    return override?.Component ?? getFileRenderer(openFilePath);
  }, [openFilePath, renderers]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<'content' | 'history' | 'compare'>('content');
  const [isManualDirty, setIsManualDirty] = useState(false);
  const [manualSaveState, setManualSaveState] = useState<RendererSaveState>('idle');
  // Last save-and-release failure, surfaced inline so a 422-with-validator
  // payload doesn't disappear into the console with the user assuming
  // their work landed. `kind: 'validation'` carries the structured KB
  // issue list; `kind: 'generic'` is the catch-all for everything else.
  const [saveError, setSaveError] = useState<
    | null
    | { kind: 'validation'; message: string; mustFix: Array<{ path?: string; message: string }> }
    | { kind: 'generic'; message: string }
  >(null);
  const [pendingDeferred, setPendingDeferred] = useState(false);
  const [hadPending, setHadPending] = useState(false);

  // **Propose mode** — the write path for a reader WITHOUT write permission.
  // Where Edit acquires the file lock and commits to this branch, Propose
  // takes no lock and never touches this branch: the text goes to the
  // caller's personal suggestions branch and surfaces as a change request
  // for the file's owners to approve. No lock because the lock protects the
  // file's canonical bytes, and a proposal does not change them.
  const [proposeMode, setProposeMode] = useState(false);
  const [proposalBusy, setProposalBusy] = useState(false);
  // The one confirmation the author gets that the proposal is now someone
  // else's to act on. Knowledge has no toast provider (see KbPageHeader),
  // so this is a banner, dismissed on the next file/mode change.
  const [proposalSent, setProposalSent] = useState(false);
  // "Loading…" between the Propose click and the editor opening: entering
  // checks for an existing open proposal and, if there is one, reads the
  // file's PROPOSED version off the suggestions branch first.
  const [isEnteringPropose, setIsEnteringPropose] = useState(false);
  /**
   * The editor's base when the caller already has an open proposal: the file
   * as it reads on THEIR suggestions branch. Seeding from it is what makes a
   * second proposal INCREMENTAL — it stacks on the pending change instead of
   * silently starting over from this branch's text and overwriting it. Null
   * = no open proposal (or the read failed): seed from the tab as before.
   */
  const [proposeSeed, setProposeSeed] = useState<string | null>(null);
  /**
   * What Send actually sends. The tab's content ref lags the editor by one
   * state propagation and — when a seed is in play — starts out pointing at
   * THIS branch's text, not the proposed text on screen. This ref is set to
   * the seed on entry and to every keystroke after, so the zero-edits case
   * sends what the editor showed, never what it replaced.
   */
  const proposeBufferRef = useRef<string | null>(null);
  // Picker overrides set by the chat tool-card's "View full comparison" link.
  // Cleared when the user opens a different file so a deep-link doesn't stick
  // around and override their natural defaults on the next open.
  const [comparisonOverride, setComparisonOverride] = useState<{
    fromBranch: string;
    toBranch: string;
  } | null>(null);
  const historyAvailable = git.availability === 'ready';
  // Losing the log CLOSES the view, rather than parking `activeTab` on it.
  // `availability` is re-derived from a polled status call, so one failed
  // poll flips it off and the next good one flips it back. Left on
  // 'history', the tab would keep the column full-bleed with no panel in it
  // (a bare document, no pane card, no way back but the next poll), and then
  // put the log back over the file the moment git recovered, minutes after
  // the reader had gone back to reading. Same rule the skill page applies to
  // its own open flag.
  if (activeTab !== 'content' && !historyAvailable) setActiveTab('content');
  const hasUnsavedWork = isManualDirty || manualSaveState === 'saving';

  const hasPending = pendingFileContent !== null;
  const pendingJustArrived = hasPending && !hadPending;
  const shouldDeferPending = pendingDeferred || (pendingJustArrived && isManualDirty);
  const isReviewingPending = hasPending && !shouldDeferPending;
  const waitingOnAgentUpdate = hasPending && shouldDeferPending;

  // Reset to the content tab whenever the user opens a different file. Leaving
  // the tab sticky means someone who was viewing history on file A lands on the
  // history tab of file B, which is surprising — opening a file should default
  // to showing what's in it.
  useEffect(() => {
    // Intentional reset-on-key-change (same pattern as useWorkspaceState):
    // opening a different file must start from the content tab.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTab('content');
    setIsManualDirty(false);
    setManualSaveState('idle');
    setSaveError(null);
    setPendingDeferred(false);
    setHadPending(false);
    setComparisonOverride(null);
  }, [openFilePath]);

  // Listen for the agent's chat tool-card "View full comparison" link. The
  // event carries the file path + both refs; we open the file (if needed),
  // jump to the Compare tab, and seed the pickers with the requested pair.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OpenComparisonDetail>).detail;
      if (!detail || !detail.path || !detail.fromBranch || !detail.toBranch) return;
      setComparisonOverride({
        fromBranch: detail.fromBranch,
        toBranch: detail.toBranch,
      });
      setActiveTab('compare');
      if (detail.path !== openFilePath) {
        addTab(detail.path).catch((err) => {
          console.error('Failed to open compared file:', detail.path, err);
          const filename = detail.path.split('/').pop() ?? detail.path;
          const msg = err instanceof Error ? err.message : 'Unknown error';
          window.alert(`Failed to open file: ${filename}\n${msg}`);
        });
      }
    };
    window.addEventListener(OPEN_COMPARISON_EVENT, handler);
    return () => window.removeEventListener(OPEN_COMPARISON_EVENT, handler);
  }, [addTab, openFilePath]);

  useEffect(() => {
    setHasUnsavedFileChanges?.(hasUnsavedWork);
  }, [hasUnsavedWork, setHasUnsavedFileChanges]);

  useEffect(() => {
    return () => {
      setHasUnsavedFileChanges?.(false);
    };
  }, [setHasUnsavedFileChanges]);

  useEffect(() => {
    if (!hasUnsavedWork) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedWork]);

  // If the agent writes while the user has unsaved edits, keep the manual buffer
  // intact and defer the pending preview until the user explicitly reviews it.
  useEffect(() => {
    const hasPendingNow = pendingFileContent !== null;

    if (!hasPendingNow) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingDeferred(false);
      setHadPending(false);
    } else if (!hadPending) {
      setPendingDeferred(isManualDirty);
      setHadPending(true);
    }
  }, [pendingFileContent, isManualDirty, hadPending]);

  // Pending review / protected branches are read-only surfaces — ensure the file-
  // level dirty indicator does not stay latched from a prior editable state.
  // Propose mode is the exception: it IS the editable surface for a reader
  // without write access, and its dirty flag is real.
  useEffect(() => {
    if ((onProtectedBranch && !proposeMode) || isReviewingPending) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsManualDirty(false);
    }
  }, [onProtectedBranch, isReviewingPending, proposeMode]);

  const handleAccept = useCallback(async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await acceptPendingContent();
      setPendingDeferred(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, acceptPendingContent]);

  const handleReject = useCallback(async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await rejectPendingContent();
      setPendingDeferred(false);
    } catch (err) {
      // Reject WRITES — the baseline back over the agent's bytes — and a
      // failed write must not read as "rejected". Same banner the save path
      // uses. (Accept performs no write, so it has no failure to surface.)
      setSaveError({
        kind: 'generic',
        message: `Couldn't reject the update: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, rejectPendingContent]);

  // **Edit mode is explicit** (the lock spec, simplified). Viewing a file
  // never claims the lock — the user clicks "Edit" to enter edit mode,
  // which acquires. Idle for `IDLE_RELEASE_MS` (two minutes)?
  // `useFileLock` auto-releases and
  // `holdingLock` flips false; the effect below mirrors that into
  // `editMode` so the UI flips back to view. To resume editing, the
  // user clicks Edit again (which tries to acquire — may fail if
  // someone else grabbed it in the gap, in which case the banner says
  // who holds it).
  const [editMode, setEditMode] = useState(false);
  // True between the Edit click and the moment we've finished
  // acquiring + reloading. Renders the button as "Loading…" and
  // disables it so a double-click can't fire two acquires.
  const [isEnteringEdit, setIsEnteringEdit] = useState(false);

  // Mirror the lock state into edit mode, but only on a transition from
  // "we held the lock" to "we don't" — that's the idle-release /
  // heartbeat-failure case where we want the UI to flip back to View
  // automatically. We can't just check `!holdingLock && editMode` every
  // render: when the user first clicks Edit, `editMode` flips true
  // before `holdingLock` does (acquire is async), and a naive check
  // would immediately revert editMode to false, defeating the whole
  // mode transition. The previous-value ref kills that race.
  //
  // Done-then-Edit race guard: `handleExitEditMode` is optimistic and
  // fires `saveAndRelease` in the background. If the user clicks Edit
  // before that release completes, we'd see `holdingLock` transition
  // true→false (from Done's background release) AFTER `editMode` has
  // already been re-set to true by the Edit click — and the naive
  // mirror would revert editMode back to false. To avoid that, Done
  // stamps `lastDoneAtRef`; the mirror ignores transitions that fall
  // within a short window after Done (longer than a typical
  // commit+push round-trip on a normal network — Done's release
  // running >`DONE_RELEASE_WINDOW_MS` would be exceptional, and the
  // worst-case outcome is one extra Edit click to recover).
  const wasHoldingLockRef = useRef(false);
  const lastDoneAtRef = useRef(0);
  const DONE_RELEASE_WINDOW_MS = 5_000;
  useEffect(() => {
    const lostLock = wasHoldingLockRef.current && !fileLock.holdingLock;
    if (lostLock && editMode) {
      const withinDoneWindow = Date.now() - lastDoneAtRef.current < DONE_RELEASE_WINDOW_MS;
      if (!withinDoneWindow) {
        setEditMode(false);
      }
    }
    wasHoldingLockRef.current = fileLock.holdingLock;
  }, [fileLock.holdingLock, editMode]);

  // Reset edit mode when switching files — opening a new tab starts in
  // View mode regardless of which mode the previous tab was in. The
  // `isEnteringEdit` flag is cleared too so a switch-during-load
  // doesn't leave the new tab's button stuck in "Loading…".
  useEffect(() => {
    // Intentional reset-on-key-change: a new file starts in View mode.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditMode(false);
    setIsEnteringEdit(false);
    setProposeMode(false);
    setProposalSent(false);
    setIsEnteringPropose(false);
    setProposeSeed(null);
    proposeBufferRef.current = null;
  }, [openFilePath, currentBranch, workspaceId]);

  // Monotonic token to scope each enter-edit flow's async completion to
  // the request that started it. When the user switches files mid-flow,
  // the `useEffect` reset on `openFilePath` clears `isEnteringEdit` and
  // bumps the token (via `setIsEnteringEdit(false)` then a new click
  // bumps); without comparing the captured token against the current
  // one, an old request's `.finally(() => setIsEnteringEdit(false))`
  // would clobber the new request's "Loading…" state on the new file.
  const enterEditRequestRef = useRef(0);
  const handleEnterEditMode = useCallback(() => {
    if (editMode || isEnteringEdit || !openFilePath || onProtectedBranch || isReviewingPending) return;
    // **Non-optimistic on entry.** We acquire the lock + reload disk
    // bytes FIRST, then flip into edit mode. The optimistic path —
    // setEditMode(true) sync, acquire + reload in the background —
    // is unsafe: any keystrokes typed in the window between the click
    // and the reload landing would be silently clobbered when fresh
    // disk bytes replace the buffer. The button shows a brief
    // "Loading…" state instead. (Exit-edit / Save stays optimistic;
    // see `handleExitEditMode` — that path is correctness-safe.)
    const targetPath = openFilePath;
    const requestId = ++enterEditRequestRef.current;
    const isStillCurrent = () =>
      requestId === enterEditRequestRef.current && openFilePathRef.current === targetPath;
    setIsEnteringEdit(true);
    fileLock.acquire()
      .then(async ({ acquired, contended, error }) => {
        if (!acquired) {
          // Two failure shapes:
          //   - Contention (`contended`): held by someone else → the "Locked
          //     by X" banner (below) already explains it; don't double-report.
          //   - Access-denied 403 / network (`error`, not contended): surface
          //     it. `useFileAccess` default-allows on a transient lookup
          //     failure, so the editor lets the user click Edit even when the
          //     authoritative backend gate refuses the lock. Without this the
          //     click just flickers "Loading…" and nothing happens — the
          //     write-denial equivalent of the file silently vanishing. We
          //     read `error` off the resolved outcome, not `fileLock.lockError`
          //     — the latter is React state and is stale in this closure.
          if (!isStillCurrent()) return;
          if (!contended && error) {
            setSaveError({ kind: 'generic', message: error });
          }
          return;
        }
        if (!isStillCurrent()) return;
        // Take-ownership reload: now that we hold the lock, refetch the
        // canonical bytes so we're editing on top of the latest
        // committed state even if a teammate's save echo hasn't
        // reached this client yet (slow SSE, dropped event, etc.).
        try {
          await reloadTabFromDisk(targetPath);
        } catch (err) {
          console.warn('[FileViewer] reload after acquire failed:', err);
          // Don't flip into edit mode if reload failed — editing on
          // top of state we couldn't verify risks the same stale-
          // overwrite the reload was meant to prevent. Also drop the
          // lock so the file isn't perpetually held while the user
          // sees no edit mode (best-effort; release failures fall to
          // the idle-release timer / unmount cleanup).
          fileLock.saveAndRelease().catch((relErr) => {
            console.warn('[FileViewer] release after reload failure failed:', relErr);
          });
          return;
        }
        // Stale-request check — file may have switched while we were
        // reloading. Don't flip editMode for the wrong file.
        if (!isStillCurrent()) return;
        setEditMode(true);
      })
      .catch((err) => {
        console.warn('[FileViewer] acquire on enter-edit failed:', err);
      })
      .finally(() => {
        // Only clear the loading flag if THIS request is still the
        // active one. A newer click already overwrote enterEditRequestRef
        // and its own `setIsEnteringEdit(true)` shouldn't get clobbered
        // back to false by an older request's finally.
        if (requestId === enterEditRequestRef.current) {
          setIsEnteringEdit(false);
        }
      });
  }, [editMode, isEnteringEdit, openFilePath, onProtectedBranch, isReviewingPending, fileLock, reloadTabFromDisk]);

  const handleExitEditMode = useCallback(() => {
    if (!editMode) return;
    // Flip to View mode SYNCHRONOUSLY. The actual save+commit+push that
    // `saveAndRelease` runs takes a full git-push round-trip (~1–3 s)
    // and we don't want the user staring at a frozen "Done" button
    // waiting for the network — they explicitly asked to leave edit
    // mode, the UI should respect that immediately.
    //
    // The save then continues in the background. The renderer is
    // already showing the post-edit content (it was the current
    // `value` when Done fired), so the user sees their work in View
    // mode while the bytes are persisted + committed + pushed behind
    // the scenes. The lock-released SSE event eventually clears the
    // server-side state for other clients.
    //
    // `lastDoneAtRef` is the race-guard for the case where the user
    // clicks Edit again BEFORE the background release completes — see
    // the mirror effect above. The Done timestamp lets that effect
    // distinguish "Done's release tail" (don't revert editMode the
    // user just re-set to true) from a genuine unexpected lock loss
    // (revert as usual).
    lastDoneAtRef.current = Date.now();
    setEditMode(false);
    setSaveError(null);
    fileLock.saveAndRelease().catch((err) => {
      // Push-needs-agent-resolution is GONE from the user-visible path.
      // Under the pending-commits queue, release just drops the lock
      // and enqueues a commit; if the eventual background commit /
      // push fails, the worker spawns a recovery agent silently.
      // Nothing surfaces here.
      console.error('[FileViewer] background save+release after Done failed:', err);
      // Surface non-resolution failures inline. Three shapes we care about:
      //   - 422 with a `validation` payload  → render the mustFix list
      //     so the user can see which KB issues are blocking the commit
      //     (per CLAUDE.md the validator gates EVERY commit, even
      //     unrelated edits — without this UI the failure looks silent).
      //   - other LockApiError                → render the server message
      //   - anything else                     → render the JS message
      // Either way we revert to edit mode so the user is back in the
      // editor (and can navigate to the failing path / retry).
      setEditMode(true);
      const validation = (err instanceof LockApiError
        ? (err.body as { validation?: { mustFix?: Array<{ path?: string; message: string }> } } | undefined)?.validation
        : undefined);
      if (validation && Array.isArray(validation.mustFix) && validation.mustFix.length > 0) {
        setSaveError({
          kind: 'validation',
          message: err instanceof Error ? err.message : 'Save was rejected by the validator.',
          mustFix: validation.mustFix,
        });
      } else {
        setSaveError({
          kind: 'generic',
          message: err instanceof Error ? err.message : 'Save failed. Please try again.',
        });
      }
    });
  }, [editMode, fileLock]);

  /**
   * Enter propose mode. If the caller already has an OPEN proposal, the
   * editor seeds from the file as it reads on their suggestions branch —
   * proposing again is a continuation, and starting from this branch's text
   * would silently overwrite their own pending change. No lock either way:
   * the lock protects the file's canonical bytes, and a proposal never
   * touches them. Any staleness against this branch shows up in the change
   * request's diff, where it is visible.
   */
  const handleEnterPropose = useCallback(() => {
    if (proposeMode || isEnteringPropose || !openFilePath) return;
    setProposalSent(false);
    setSaveError(null);
    const targetPath = openFilePath;
    setIsEnteringPropose(true);
    (async () => {
      let seed: string | null = null;
      const user = auth.user;
      const prefix = kbDirName ? `${kbDirName}/` : null;
      if (user && prefix && targetPath.startsWith(prefix)) {
        let existing = null;
        try {
          const branch = knowledgeSuggestionBranchFor(user);
          const mine = await listMyChangeRequests();
          existing = mine.find((c) => c.state === 'open' && c.branch === branch) ?? null;
          if (existing) {
            seed = await readFileOnBranch(branch, targetPath.slice(prefix.length));
          }
        } catch (err) {
          // TWO failure causes, and only one may degrade. "Is there an open
          // proposal?" failing means we KNOW nothing — seed from this branch,
          // which is better than a propose button that does nothing. But a
          // proposal we KNOW exists and could not read must refuse: opening
          // the editor on this branch's text and sending would silently
          // replace the caller's pending proposal — the exact overwrite the
          // seed exists to prevent.
          if (existing) {
            console.warn('[FileViewer] could not read the open proposal:', err);
            if (openFilePathRef.current === targetPath) {
              setSaveError({
                kind: 'generic',
                message:
                  "Couldn't load your open proposal, so the editor stayed closed. Try again in a moment.",
              });
            }
            return;
          }
          console.warn('[FileViewer] could not check for an open proposal:', err);
          seed = null;
        }
      }
      // Switched files while the seed loaded — this propose is moot.
      if (openFilePathRef.current !== targetPath) return;
      setProposeSeed(seed);
      proposeBufferRef.current = seed ?? openFileContentRef.current;
      setProposeMode(true);
    })().finally(() => setIsEnteringPropose(false));
  }, [proposeMode, isEnteringPropose, openFilePath, auth.user, kbDirName]);

  /** Leave propose mode, throwing the typed text away and re-reading disk. */
  const handleDiscardProposal = useCallback(() => {
    setProposeMode(false);
    setProposeSeed(null);
    proposeBufferRef.current = null;
    if (openFilePath) {
      reloadTabFromDisk(openFilePath).catch((err) => {
        console.warn('[FileViewer] reload after discarding a proposal failed:', err);
      });
    }
  }, [openFilePath, reloadTabFromDisk]);

  /**
   * Send the proposal: the buffer goes to the caller's personal suggestions
   * branch and an open change request against the default branch is created
   * (or reused — one bundle per person). The file on THIS branch is untouched,
   * so on success the tab re-reads disk: leaving the proposed text on screen
   * would claim the file now says something it does not.
   */
  const handleSendProposal = useCallback(async (contentOverride?: string) => {
    const path = openFilePathRef.current;
    // Ctrl+S hands the renderer's buffer straight in; the Send button has no
    // buffer of its own and falls back to the propose buffer (seed +
    // keystrokes), then to the tab's mirror.
    const content = contentOverride ?? proposeBufferRef.current ?? openFileContentRef.current;
    if (!path || !kbDirName || !auth.user || content === null || proposalBusy) return;
    const prefix = `${kbDirName}/`;
    if (!path.startsWith(prefix)) return;
    // Nothing typed over an existing proposal: the branch already says
    // exactly this. Close the editor rather than pushing an empty commit at
    // the change request.
    if (proposeSeed !== null && content === proposeSeed) {
      setProposeMode(false);
      setProposeSeed(null);
      proposeBufferRef.current = null;
      if (openFilePathRef.current === path) {
        reloadTabFromDisk(path).catch(() => {});
      }
      return;
    }
    setProposalBusy(true);
    setSaveError(null);
    try {
      await proposeKnowledgeChange({
        repoRelativePath: path.slice(prefix.length),
        content,
        userEmail: auth.user.email,
        userId: auth.user.id,
        userName: auth.user.name,
      });
      setProposeMode(false);
      setProposeSeed(null);
      proposeBufferRef.current = null;
      setProposalSent(true);
      // The same signal a share dialog or an agent turn sends: the open
      // change-request list just changed, so the tree dots and the page
      // banner refetch.
      window.dispatchEvent(new Event(PR_STALE_EVENT));
      if (openFilePathRef.current === path) {
        await reloadTabFromDisk(path);
      }
    } catch (err) {
      console.error('[FileViewer] sending a proposal failed:', err);
      setSaveError({
        kind: 'generic',
        message: err instanceof Error ? err.message : "Couldn't send your proposed change.",
      });
    } finally {
      setProposalBusy(false);
    }
  }, [kbDirName, auth.user, proposalBusy, proposeSeed, reloadTabFromDisk]);

  // Save flow (PLAN §2):
  //   - Lock is already held because we're in edit mode (handleEnterEditMode
  //     guarantees it). Save = checkpoint commit, lock stays held so
  //     subsequent keystrokes don't have to re-acquire.
  //   - Final commit + release happens on exit-edit, unmount, file switch,
  //     or `IDLE_RELEASE_MS` of inactivity (the hook's idle timer).
  const handleSave = useCallback(async (content: string) => {
    if (!openFilePath) return;
    openFileContentRef.current = content;
    if (!fileLock.holdingLock) {
      // Defensive: this path runs when a save fires without us being in
      // edit mode (rare — renderer is readOnly when !editMode, so
      // normally only the explicit Edit-button + saveCheckpoint flow
      // reaches here). Acquire the lock, commit-and-release as a
      // one-shot, and stay in View mode. We deliberately do NOT call
      // `setEditMode(true)` — the user didn't ask to enter Edit mode,
      // they just hit save, so the UI shouldn't silently promote them.
      // `saveAndRelease` handles the full commit-then-release-then-
      // push cycle in one call.
      const { acquired, error } = await fileLock.acquire();
      if (!acquired) {
        // Read the message off the resolved outcome, not `fileLock.lockError`
        // — that's React state and is stale in this closure right after the
        // await. Covers both the access-denied 403 and lock-contention cases.
        throw new Error(error ?? 'File is locked by another user.');
      }
      try {
        await fileLock.saveAndRelease();
      } catch (error) {
        console.error('Failed transient save:', error);
        throw error;
      }
      return;
    }
    try {
      await fileLock.saveCheckpoint();
    } catch (error) {
      console.error('Failed to save file:', error);
      throw error;
    }
  }, [openFilePath, fileLock]);

  // Track keystroke + scroll activity so the lock hook's idle timer
  // resets while the user is doing anything with the file. Without
  // this, a long meeting spent reading the file would auto-release.
  const recordActivity = fileLock.recordActivity;
  const handleValueChange = useCallback((value: string) => {
    recordActivity();
    // Keep the propose buffer current too — harmless in edit mode, and in
    // propose mode it is what Send reads (see `proposeBufferRef`).
    proposeBufferRef.current = value;
    setActiveTabContent(value);
  }, [recordActivity, setActiveTabContent]);

  // Scroll handler attached to the editor container. Any scroll within
  // the file counts as activity — the user is reading, even if not
  // typing. Without this, a long meeting spent reading the file would
  // auto-release the lock just because nothing was typed.
  const editorContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = editorContainerRef.current;
    if (!el || !editMode) return;
    const onScroll = () => recordActivity();
    // Capture-phase so a scroll on a nested element (the editor
    // textarea, a code-mirror viewport, etc.) reaches us without the
    // child having to bubble. Passive so we don't block the scroll.
    el.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => el.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
  }, [editMode, recordActivity]);

  // No-op save when previewing pending content — don't let edits go through during review
  const handlePendingSave = useCallback(async () => {}, []);

  const handleReviewAgentUpdate = useCallback(() => {
    if (!waitingOnAgentUpdate || isManualDirty) return;
    setPendingDeferred(false);
  }, [waitingOnAgentUpdate, isManualDirty]);

  // Canonical link for the open file: the node's id URL when it's a node, else
  // its path URL (resolved in the background, falls back to the path meanwhile).
  const canonicalFileUrl = useCanonicalFileUrl(openFilePath);
  // Each copy resolves to whether it actually landed. `navigator.clipboard`
  // rejects outright on a non-secure origin, and the header says so on the
  // control that was clicked rather than swallowing it.
  const handleCopyLink = useCallback(async () => {
    try {
      const base = canonicalFileUrl ?? `${window.location.origin}${window.location.pathname}`;
      await navigator.clipboard.writeText(base + window.location.hash);
      return true;
    } catch (err) {
      console.error('Failed to copy link:', err);
      return false;
    }
  }, [canonicalFileUrl]);

  // "Copy page as Markdown" is the document's own source. It is offered only
  // when there IS markdown to copy — a PDF or an image has none, and copying
  // a blob's bytes as text is nonsense rather than a feature.
  const canCopyPage = !!openFilePath && /\.(md|markdown)$/i.test(openFilePath);
  const handleCopyPage = useCallback(async () => {
    if (openFileContent === null) return false;
    try {
      await navigator.clipboard.writeText(openFileContent);
      return true;
    } catch (err) {
      console.error('Failed to copy page:', err);
      return false;
    }
  }, [openFileContent]);

  // Manage access on the open file, reached from the page's Share button.
  //
  // This page shares ONE thing: the file you are reading. It used to also
  // offer "Share the whole folder", and that went — from a file's page it was
  // a single click away from handing over everything in the folder, with
  // nothing on screen showing what "everything" was. Sharing a folder now
  // starts where the folder is: its row in the tree, right-click → Manage
  // access, next to the children it governs.
  const [shareTarget, setShareTarget] = useState<FileTreeEntry | null>(null);
  const handleShare = useCallback(() => {
    if (!openFilePath) return;
    setShareTarget({
      name: openFilePath.slice(openFilePath.lastIndexOf('/') + 1),
      relativePath: openFilePath,
      type: 'file',
    });
  }, [openFilePath]);

  // Where to start, for a viewer with nothing open. Computed here rather than
  // in the empty branch below because that branch is a `return` and this is a
  // hook — and it costs nothing while a file IS open, which is the common case.
  const suggestions = useMemo(
    () => suggestedPages(fileTree, SUGGESTION_LIMIT),
    [fileTree],
  );
  // Opening a suggestion is NAVIGATION, the same as clicking the file in the
  // explorer or a tab: the URL is the canonical record of what is open, and a
  // refresh, share or back-press must land on the page — not on the empty
  // state this button was clicked from. `openWorkspacePath`, not `openFile`:
  // these are real tree paths, and a `#` in a filename is a character, not an
  // anchor. Navigation needs the branch, so the buttons wait for it rather
  // than rendering a click that silently does nothing while git status loads.
  const { openWorkspacePath } = useFileNav();
  // "Ready" is the same predicate `FileRoute` uses to decide the workspace is
  // actually backing this route: the branch is known AND it is the branch the
  // URL names. Mid-switch the status still reports the branch being left, and
  // navigating on that would send the reader back to the branch they just
  // left — a worse outcome than a button that waits a moment.
  // The param arrives ALREADY decoded — the router percent-decodes path params
  // — so it is compared as-is. Decoding again would turn a branch named
  // `my%20branch` into `my branch`, which matches nothing and would leave the
  // offers disabled for good on that deployment.
  const routeBranch = useParams<{ branch: string }>().branch;
  const navReady = !!git.status?.branch && (!routeBranch || git.status.branch === routeBranch);

  // ALL open requests, not just the ones scoped to you — a colleague's request
  // on a file you can read but not write still belongs on this page.
  const openChangeRequests = useOpenChangeRequests();
  const requestsOnThisFile = openFilePath ? openChangeRequests.forPath(openFilePath) : [];
  // The full-bleed banner's "Review the change" opens the SHARED
  // change-request dialog — the old PR viewer surface is gone.
  const [bannerCr, setBannerCr] = useState<PullRequestSummary | null>(null);

  if (!openFilePath || openFileContent === null || !Renderer) {
    return (
      <div className="h-full w-full flex flex-col bg-white min-w-0 relative">
        <PullNeededBanner />
        <GitSyncFailedBanner />
        <EditorTabs />
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="w-full max-w-md text-center">
            <h2 className="mb-2 text-head text-ink">Open a page to start reading.</h2>
            <p className="mb-6 text-ui text-ink-muted">
              {suggestions.length > 0
                ? 'Pick anything from the file tree, or start with one of these.'
                : 'Pick anything from the file tree.'}
            </p>
            {/* Real pages, not prompts. Whoever lands here has a file tree and
                a blank pane, and "browse until something looks right" is the
                one instruction the tree already gives — so the suggestions are
                documents that open, drawn from the top of the knowledge the
                deployment actually holds. */}
            {suggestions.length > 0 && (
              <div className="flex flex-col gap-2 text-left">
                {suggestions.map((page) => {
                  const folder = parentFolder(page.relativePath);
                  return (
                    <Surface
                      key={page.relativePath}
                      as="button"
                      tone="sunken"
                      radius="lg"
                      elevation="none"
                      interactive
                      type="button"
                      onClick={() => openWorkspacePath(page.relativePath)}
                      disabled={!navReady}
                      className="flex items-center gap-2.5 px-3 py-2"
                    >
                      <FileText size={15} className="shrink-0 text-ink-faint" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-ui text-ink">
                        {pageTitle(page.name)}
                      </span>
                      {/* The folder it sits in — two pages can share a name,
                          and the one thing that tells them apart is where they
                          live. */}
                      {/* Capped so a long folder name truncates instead of
                          squeezing out the page title it is there to
                          disambiguate — same contract as the comparison
                          panel's path label. */}
                      {folder && (
                        <span className="max-w-[40%] shrink-0 truncate text-meta text-ink-faint">
                          {folder}
                        </span>
                      )}
                    </Surface>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {registeredPanels}
      </div>
    );
  }

  // Which shape the document column takes. A history / comparison panel is a
  // fixed-height viewport with its own scroller (both roots are
  // `flex-1 flex flex-col min-h-0`), so it gets the full-bleed contract for
  // the same reason a PDF does — an auto-height column would collapse it.
  const shellVariant =
    activeTab === 'content' ? getRendererLayout(openFilePath) : 'full-bleed';

  // No-preview routes (legacy Office, ODF) have no editing surface at all —
  // offering Edit/Propose there would acquire a lock for a mode the renderer
  // ignores, and imply text can be saved over a binary document. Suppresses
  // BOTH write-action homes (the pane bar and the header) below.
  const viewOnly = isViewOnlyFile(openFilePath);

  // What the pane card's bar names — extension kept, unlike the `<h1>` above,
  // because the bar is the technical label (`SKILL.md`, `How to get
  // started.md`) exactly as the skill page's file bar renders it.
  const fileBaseName = openFilePath.slice(openFilePath.lastIndexOf('/') + 1);

  // The repo-relative path (kbDirName stripped) — what the change-request
  // machinery speaks. Null for files outside the KB clone, which cannot have
  // change requests.
  const repoRelativePath =
    kbDirName && openFilePath.startsWith(`${kbDirName}/`)
      ? openFilePath.slice(kbDirName.length + 1)
      : null;
  const ownersLabel =
    access.owners.roles.length > 0 || access.owners.users.length > 0
      ? formatEligible(access.owners)
      : 'the owners';

  const rendererElement = (
    // The renderer is a dynamic per-extension lookup resolved in a useMemo
    // above — not a component created during render. The provider hands the
    // open file's `download:` verdict to any DownloadFileButton inside the
    // renderer without widening the renderer contract.
    // eslint-disable-next-line react-hooks/static-components
    <CanDownloadContext.Provider value={access.canDownload}>
    <Renderer
      // **Why we key on `openFileSavedContent` (read-only mode only).**
      // When a teammate's save lands, the workspace state updates the
      // tab's content + savedContent. The renderer's internal
      // `useState(content)` + sync-on-prop-change `useEffect` is
      // supposed to pull the new value into `value`, but in practice
      // (production build, multiple suspended subscribers, etc.) we
      // were seeing the preview stay on the stale buffer until the
      // user manually closed + reopened the tab. Keying the renderer
      // on the bytes themselves forces a fresh mount when those
      // bytes change, which initializes `value` from the latest
      // content prop directly and bypasses any stuck-state edge
      // case. We gate this on `!editMode` so the user's in-flight
      // edits (where `value` diverges from `savedContent`) don't
      // trigger a remount that would discard their typing —
      // savedContent stays stable through an edit until the save
      // commits, then advances once.
      key={editMode || proposeMode ? `${openFilePath}|edit` : `${openFilePath}|${openFileSavedContent?.length ?? 0}|${openFileSavedContent?.slice(0, 64) ?? ''}|${openFileSavedContent?.slice(-64) ?? ''}`}
      // In propose mode with an open proposal, the buffer AND the dirty
      // baseline are the PROPOSED text (the seed) — the editor continues the
      // pending change, and "dirty" means "differs from what I already
      // proposed", not "differs from this branch".
      content={
        isReviewingPending
          ? pendingFileContent!
          : proposeMode && proposeSeed !== null
            ? proposeSeed
            : openFileContent
      }
      savedContent={
        isReviewingPending
          ? pendingFileContent!
          : proposeMode && proposeSeed !== null
            ? proposeSeed
            : (openFileSavedContent ?? openFileContent)
      }
      filePath={openFilePath}
      // In propose mode a save (Ctrl+S) IS sending the proposal — the
      // one thing it must never be is a write to this branch.
      onSave={
        isReviewingPending
          ? handlePendingSave
          : proposeMode
            ? handleSendProposal
            : onProtectedBranch
              ? handlePendingSave
              : handleSave
      }
      onDirtyChange={setIsManualDirty}
      onValueChange={
        isReviewingPending || !(editMode || proposeMode) ? undefined : handleValueChange
      }
      onSaveStateChange={setManualSaveState}
      readOnly={isReviewingPending || !(editMode || proposeMode)}
    />
    </CanDownloadContext.Provider>
  );

  // The pane bar's write action — the labelled button at the frame's top
  // left, same slot the skill page uses. What it says is the access answer:
  // `Edit` when you may write the file, `Propose changes` when you may not
  // (null = lookup in flight = optimistic Edit, exactly the header's old
  // rule). While a mode is OPEN it shows the way out instead. The header's
  // own cluster is suppressed for prose files (`writeActionInPane`).
  const lockedBy = fileLock.externalLock?.holderName ?? null;
  const writeAction = isReviewingPending || viewOnly ? null : proposeMode ? (
    <>
      <Button variant="quiet" size="tiny" onClick={handleDiscardProposal} disabled={proposalBusy}>
        Discard
      </Button>
      <Button
        variant="primary"
        size="tiny"
        onClick={() => void handleSendProposal()}
        disabled={proposalBusy}
        title="Send your proposed change for approval"
      >
        {proposalBusy ? 'Sending…' : 'Send proposal'}
      </Button>
    </>
  ) : editMode ? (
    <Button
      variant="outline"
      size="tiny"
      onClick={handleExitEditMode}
      title="Save changes and return to view mode"
    >
      Done
    </Button>
  ) : accessRestricted ? (
    <Button
      variant="outline"
      size="tiny"
      disabled={isEnteringPropose}
      onClick={handleEnterPropose}
      title={
        isEnteringPropose
          ? 'Checking for an open proposal…'
          : "You can't edit this file directly. Propose a change for its owners to approve"
      }
    >
      {isEnteringPropose ? 'Loading…' : 'Propose changes'}
    </Button>
  ) : (
    <Button
      variant="outline"
      size="tiny"
      disabled={!!lockedBy || isEnteringEdit}
      onClick={handleEnterEditMode}
      title={
        lockedBy
          ? `Locked by ${lockedBy}`
          : isEnteringEdit
            ? 'Acquiring lock and fetching latest content…'
            : 'Click to edit this file'
      }
    >
      {isEnteringEdit ? 'Loading…' : 'Edit'}
    </Button>
  );
  // "Who changed this, when" — the clock-arrow beside Edit, where Google Docs
  // keeps it. It sits in the bar for the same reason Edit does: history is a
  // thing you do to THE FILE, and the bar is where the file's actions live.
  // It used to be the lone item behind a ⋯ in the page header — two clicks
  // and a menu for a question people ask often. Not gated on `viewOnly` or a
  // pending review: reading the log changes nothing. Full-bleed renderers
  // have no bar, so the header carries it for them (`historyInPane`).
  const historyAction = historyAvailable ? (
    <IconButton
      aria-label="Version history"
      title="Version history"
      onClick={() => setActiveTab('history')}
    >
      <History size={14} />
    </IconButton>
  ) : null;
  const paneActions =
    historyAction || writeAction ? (
      <>
        {historyAction}
        {writeAction}
      </>
    ) : null;

  return (
    <div className="h-full w-full flex flex-col bg-white min-w-0 relative">
      <PullNeededBanner />
      <GitSyncFailedBanner />
      {/* No "you don't have permission to edit" banner, deliberately: for a
          reader the restriction is not news worth a stripe across every page —
          the Propose changes affordance already says what they CAN do, and the
          detailed who-may-edit copy still appears where it answers a question
          (the disabled-save tooltip). */}
      {/* ONE column holds the tabs, the title and the text at the same width,
          so they share an edge and the page reads as a single centred block
          (proto:700-705). `editorContainerRef` goes to `scrollRef` because the
          shell is now the element that scrolls — the capture-phase listener
          bound to it is the file lock's only activity signal for a reader. */}
      <KbDocumentShell
              roomy={explorerHidden}
        variant={shellVariant}
        scrollRef={editorContainerRef}
      >
      <EditorTabs />
      {/* The document names itself, and its actions sit beside its name.
          Everything the deleted 40px strip carried is here — the three chips
          as Badges, Edit with the same handlers and the same lock semantics,
          the copy-link that used to be an icon in the corner — plus Share and
          the overflow the prototype puts on the page. */}
      <KbPageHeader
        path={openFilePath}
        canWrite={access.canWrite}
        editMode={editMode}
        entering={isEnteringEdit}
        proposeMode={proposeMode}
        proposalBusy={proposalBusy}
        onPropose={handleEnterPropose}
        onSendProposal={() => void handleSendProposal()}
        onDiscardProposal={handleDiscardProposal}
        // `viewOnly` rides the same flag: it tells the header "the write
        // action is not yours to render" — and the pane bar renders none.
        writeActionInPane={shellVariant === 'prose' || viewOnly}
        // Prose gets a pane card, and the card's bar carries Version history
        // beside Edit. Not `viewOnly`: a view-only full-bleed file has no bar.
        historyInPane={shellVariant === 'prose'}
        lockedBy={fileLock.externalLock?.holderName ?? null}
        historyAvailable={historyAvailable}
        isDirty={isManualDirty}
        waitingOnAgentUpdate={waitingOnAgentUpdate}
        isReviewingPending={isReviewingPending}
        activeTab={activeTab}
        onEdit={handleEnterEditMode}
        onDone={handleExitEditMode}
        // While the log is open the column is full-bleed, so the header
        // carries the clock (pressed). A second click on a pressed clock is a
        // request to put the document back, not to open the log again.
        onOpenHistory={() => setActiveTab((t) => (t === 'history' ? 'content' : 'history'))}
        onShare={handleShare}
        onCopyPage={canCopyPage ? handleCopyPage : undefined}
        onCopyLink={handleCopyLink}
      />

      {/* Content stopped being a tab: the document IS the page, and history
          and comparison are two things you can go and look at. Each renders in
          place of the body with an explicit way back — without it the only
          route home would be reopening the file. */}
      {activeTab === 'history' && historyAvailable ? (
        <>
          <BackToDocument onBack={() => setActiveTab('content')} label="Version history" />
          <FileHistoryPanel filePath={openFilePath} />
        </>
      ) : activeTab === 'compare' && historyAvailable ? (
        <>
          <BackToDocument onBack={() => setActiveTab('content')} label="Compare versions" />
          <FileComparisonPanel
            filePath={openFilePath}
            initialFrom={comparisonOverride?.fromBranch ?? null}
            initialTo={comparisonOverride?.toBranch ?? null}
            refreshKey={fsRevision}
          />
        </>
      ) : (
        <>
          {/* Somebody has proposed a change to this file. For a DOCUMENT the
              proposals render as change boxes UNDER the file (below) — the
              skill page's presentation, because the question they ask is
              unanswerable without the text. This banner remains only for
              full-bleed files, which have no below to put a box in. The
              signal comes from the broad endpoint, not from the dock's
              you-scoped queue, so a colleague's request on a file you can
              read but not write still shows. */}
          {requestsOnThisFile.length > 0 && shellVariant !== 'prose' && (
            <Banner role="note" tone="wait" className="mb-4 flex-none">
              <div className="font-semibold">
                {requestsOnThisFile.length === 1
                  ? 'Open change request'
                  : `${requestsOnThisFile.length} open change requests`}
              </div>
              <div className="mt-0.5 text-detail text-ink-muted">
                {requestsOnThisFile[0].appAuthor?.name ?? requestsOnThisFile[0].author.login}{' '}
                proposed “{requestsOnThisFile[0].title}”. Nothing here changes until someone
                with write access applies it.
              </div>
              <div className="mt-3">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setBannerCr(requestsOnThisFile[0])}
                >
                  Review the change
                </Button>
              </div>
            </Banner>
          )}
          {/* Propose mode's one-line contract: where the text goes, and that
              nothing on this page changes until someone with write access
              says yes. Shown INSTEAD of the access-restricted banner. */}
          {proposeMode && (
            <Banner role="status" tone="wait" aria-live="polite" className="mb-4 flex-none">
              You're proposing a change. Nothing here changes until someone with write
              access approves it.
            </Banner>
          )}
          {proposalSent && (
            <Banner
              role="status"
              tone="ok"
              icon={<Check size={14} />}
              aria-live="polite"
              className="mb-4 flex-none"
            >
              <div className="flex items-center gap-2">
                <span className="flex-1">
                  Your proposed change was sent as a change request.
                </span>
                <Button variant="quiet" size="sm" title="Dismiss" onClick={() => setProposalSent(false)}>
                  Dismiss
                </Button>
              </div>
            </Banner>
          )}
          {waitingOnAgentUpdate && (
            <Banner
              role="status"
              tone="wait"
              aria-live="polite"
              aria-atomic="true"
              className="mb-4 flex-none items-center"
            >
              <div className="flex items-center gap-2">
                <span className="flex-1">
                  Agent update is waiting. Save or undo your unsaved edits before reviewing it.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReviewAgentUpdate}
                  disabled={isManualDirty}
                  title={isManualDirty ? 'Finish local edits first' : 'Open the agent update preview'}
                >
                  Review agent update
                </Button>
              </div>
            </Banner>
          )}
          {/* Accept / Reject banner for a single previewed agent update. */}
          {isReviewingPending && (
            <Banner
              role="status"
              tone="neutral"
              aria-live="polite"
              aria-atomic="true"
              className="mb-4 flex-none"
            >
              <div className="flex items-center gap-2">
                <span className="flex-1">
                  Previewing agent's changes: accept to keep, reject to undo
                </span>
                <Button
                  variant="quiet"
                  size="sm"
                  leadingIcon={<XCircle size={13} />}
                  onClick={handleReject}
                  disabled={isSubmitting}
                >
                  Reject
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  leadingIcon={<Check size={13} />}
                  onClick={handleAccept}
                  disabled={isSubmitting}
                >
                  Accept
                </Button>
              </div>
            </Banner>
          )}

          {/* Lock-by-someone-else banner — read-only state until the holder releases. */}
          {fileLock.externalLock && !fileLock.holdingLock && !isReviewingPending && !onProtectedBranch && (
            <Banner
              role="status"
              tone="wait"
              icon={<Lock size={14} />}
              aria-live="polite"
              aria-atomic="true"
              className="mb-4 flex-none"
            >
              Locked by <span className="font-medium">{fileLock.externalLock.holderName}</span>. The editor is read-only until they finish.
            </Banner>
          )}

          {/* Save-failure banner. Validator failures carry a structured
              `mustFix` list which we render so the user can see which KB
              issues are blocking the commit (the validator gates ALL
              commits, even unrelated edits — without this UI the failure
              looks silent and the user keeps clicking Save). */}
          {saveError && (
            <Banner
              role="alert"
              tone="danger"
              icon={<AlertTriangle size={14} />}
              aria-live="assertive"
              className="mb-4 flex-none"
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 font-medium">{saveError.message}</span>
                <Button variant="quiet" size="sm" title="Dismiss" onClick={() => setSaveError(null)}>
                  Dismiss
                </Button>
              </div>
              {/* The validator gates EVERY commit, even an unrelated edit, so
                  the structured issue list is the only way the user learns
                  which KB problem is blocking their save. The 20-item cap and
                  its "…and N more" tail stay. */}
              {saveError.kind === 'validation' && saveError.mustFix.length > 0 && (
                <ul className="mt-1.5 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-4 text-detail">
                  {saveError.mustFix.slice(0, 20).map((issue, i) => (
                    <li key={i}>
                      {issue.path && <span className="font-mono">{issue.path}</span>}
                      {issue.path && ': '}
                      {issue.message}
                    </li>
                  ))}
                  {saveError.mustFix.length > 20 && (
                    <li className="italic">…and {saveError.mustFix.length - 20} more</li>
                  )}
                </ul>
              )}
            </Banner>
          )}

          {/* File content — show pending (new) content when reviewing, accepted content otherwise.
              Lock semantics: the editor is read-only whenever we're not in
              explicit Edit mode. Edit mode is gated by the lock, so this
              also covers "someone else holds it" without a separate check.
              The scroll-activity source for the idle-release timer is the
              shell above, not this wrapper — see `KbDocumentShell.scrollRef`.

              A PROSE document sits inside `FilePaneCard` — the same edged
              frame, with the same mono filename bar, that the skill page puts
              around its files. One file-in-a-box drawing for the whole app;
              full-bleed renderers (pdf, csv, images…) are viewports, not
              documents, and keep their unframed definite-height contract. */}
          <div className={shellVariant === 'full-bleed' ? 'flex min-h-0 flex-1 flex-col' : 'min-w-0'}>
            {shellVariant === 'prose' ? (
              <>
                <FilePaneCard file={fileBaseName} actions={paneActions}>
                  {rendererElement}
                </FilePaneCard>
                {/* Every open proposal on this file, under the file it is
                    about — the same boxes, the same dialog, as the skill
                    page. Hidden while the reader IS editing or proposing:
                    the diffs are against text that is changing under them. */}
                {!editMode && !proposeMode && repoRelativePath && requestsOnThisFile.length > 0 && (
                  <FileChangeBoxes
                    repoRelativePath={repoRelativePath}
                    requests={requestsOnThisFile}
                    canDecide={access.canWrite === true}
                    ownersLabel={ownersLabel}
                    onApplied={() => {
                      reloadTabFromDisk(openFilePath).catch(() => {});
                    }}
                  />
                )}
              </>
            ) : (
              rendererElement
            )}
          </div>
        </>
      )}
      </KbDocumentShell>
      {registeredPanels}
      {bannerCr && (
        <ChangeRequestDialog
          cr={bannerCr}
          onClose={() => setBannerCr(null)}
          // Applying is the only verdict the dialog reaches now.
          onResolved={() => {
            setBannerCr(null);
            window.dispatchEvent(new Event(PR_STALE_EVENT));
            reloadTabFromDisk(openFilePath).catch(() => {});
          }}
        />
      )}
      {shareTarget && (
        <ManageAccessDialog
          key={shareTarget.relativePath}
          entry={shareTarget}
          // Keyed on the path, so retargeting at a parent remounts the sheet
          // against that folder — the whole thing is this one setter.
          onManageAncestor={setShareTarget}
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
}

/**
 * The way back from a panel that took the document's place.
 *
 * `Content` is no longer a tab, so there is no tab to click to return. Without
 * this row the only route home from Version history is reopening the file.
 */
function BackToDocument({ onBack, label }: { onBack(): void; label: string }) {
  return (
    <div className="mb-3 flex shrink-0 items-center gap-2">
      <Button variant="quiet" size="sm" leadingIcon={<ArrowLeft size={13} />} onClick={onBack}>
        Back to the document
      </Button>
      <span className="text-detail text-ink-faint">{label}</span>
    </div>
  );
}
