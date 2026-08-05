import { useMemo, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Check, XCircle, Lock, AlertTriangle, ArrowLeft } from 'lucide-react';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import { useWorkspace } from '../state/workspace.context';
import { EditorTabs } from './EditorTabs';
import { KbPageHeader } from './KbPageHeader';
import { KbFileRail, KB_FILE_RAIL_HEADING_ID } from './KbFileRail';
import { useLinksOut } from '../hooks/useLinksOut';
import { useOpenChangeRequests } from '../hooks/useOpenChangeRequests';
import { usePrViewer } from '../../pr/state/pr-viewer.context';
import { useLastCommit } from '../hooks/useLastCommit';
import { openRawFile } from '../utils/openRawFile';
import { Banner, Button, Surface } from '../../../shared/components';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { useGit } from '../../git/state/git.context';
import { LayoutContext } from '../../layout/state/layout.context';
import { useCanonicalFileUrl, useFileNav, resolveRelativePath } from '../routing/kb-routes';
import { useReview } from '../../review/state/review.context';
import { PullNeededBanner } from '../../git/components/PullNeededBanner';
import { useFileAccess } from '../../access/hooks/useFileAccess';
import { AccessRestrictedBanner } from '../../access/components/AccessRestrictedBanner';
import { FileHistoryPanel } from '../../git/components/FileHistoryPanel';
import { FileComparisonPanel } from '../../git/components/FileComparisonPanel';
import {
  OPEN_COMPARISON_EVENT,
  type OpenComparisonDetail,
} from '../../../core/events';
import {
  useAppRegistry,
  useSuggestedPromptSeed,
} from '../../../core/registry';
import { PrViewer } from '../../pr/components/PrViewer';
import { useFileLock } from '../../workflow/hooks/useFileLock';
import { LockApiError } from '../../workflow/services/lock.api';
import { useAuth } from '../../auth/state/auth.context';
import { getFileRenderer, getRendererLayout, isBinaryFile } from './renderers';
import type { RendererSaveState } from './renderers';
import { KbDocumentShell } from './KbDocumentShell';

const SUGGESTED_PROMPTS = [
  'Give me an overview of the process landscape.',
  'What are the main process modules?',
  'Show me the Registration & Onboarding processes.',
];

export function FileViewer() {
  const {
    workspaceId,
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
    refreshFileTree,
    bumpFsRevision,
    reloadTabFromDisk,
  } = useWorkspace();
  // Chat decoupling: the suggested-prompt seed is an optional registry port
  // (null when no chat surface is registered → the prompt buttons hide).
  const seedSuggestedPrompt = useSuggestedPromptSeed();
  const { fileViewerPanels, renderers } = useAppRegistry();
  const git = useGit();
  const review = useReview();
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
  // `hasPendingReview` (the fact that a review session exists) suppresses the
  // legacy single-file Accept/Reject banner below so the two review UIs don't
  // compete. The review *surface* itself (badge + panel, with its own
  // open-intent state) is no longer hard-mounted here — it's a registered
  // panel (see `fileViewerPanels` / the enterprise ReviewPanelSurface), so
  // the core viewer carries no review-UI dependency.
  const hasPendingReview = !!review.session && review.session.changes.length > 0;
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
  // Picker overrides set by the chat tool-card's "View full comparison" link.
  // Cleared when the user opens a different file so a deep-link doesn't stick
  // around and override their natural defaults on the next open.
  const [comparisonOverride, setComparisonOverride] = useState<{
    fromBranch: string;
    toBranch: string;
  } | null>(null);
  const historyAvailable = git.availability === 'ready';
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
      setPendingDeferred(false);
      setHadPending(false);
    } else if (!hadPending) {
      setPendingDeferred(isManualDirty);
      setHadPending(true);
    }
  }, [pendingFileContent, isManualDirty, hadPending]);

  // Pending review / protected branches are read-only surfaces — ensure the file-
  // level dirty indicator does not stay latched from a prior editable state.
  useEffect(() => {
    if (onProtectedBranch || isReviewingPending) {
      setIsManualDirty(false);
    }
  }, [onProtectedBranch, isReviewingPending]);

  const handleRevertCompleted = useCallback(async () => {
    await refreshFileTree();
    // A revert writes to the working tree, so the active tab's cached content
    // is stale. Bump fs revision — the hook's invalidation effect refetches
    // the active tab, and if the file no longer exists (e.g. revert of its
    // creation), drops it from the tab list. The state→URL effect in
    // FileRoute then updates the URL to the new active tab.
    bumpFsRevision();
    await git.refreshStatus();
    // A revert writes to the working tree, so pending-review state may no
    // longer match what's on disk. Refresh the session before switching tabs
    // so the review panel reflects the reconciled paths.
    await review.refresh();
    setActiveTab('content');
  }, [refreshFileTree, bumpFsRevision, git, review]);

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
    setEditMode(false);
    setIsEnteringEdit(false);
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

  // `⋯ → View raw file`. Wrapped in a helper rather than assigning
  // `window.location.href` inline so a test can spy on the intent without the
  // navigation (§2.3 forbids assigning location.href in a test).
  const handleViewRaw = useCallback(() => {
    if (!workspaceId || !openFilePath) return;
    openRawFile(workspaceId, openFilePath);
  }, [workspaceId, openFilePath]);

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

  // Session state, defaulting closed. Open ⇒ the shell switches to the wide
  // measure and opens the rail's track. Closed costs nothing: `useLastCommit`
  // is gated on it, so a reader who never opens the rail never pays for the
  // history request behind its "Edited" row.
  const [railOpen, setRailOpen] = useState(false);
  const linksOut = useLinksOut(openFilePath, openFileContent);
  // ALL open requests, not just the ones scoped to you — a colleague's request
  // on a file you can read but not write still belongs on this page.
  const openChangeRequests = useOpenChangeRequests();
  const requestsOnThisFile = openFilePath ? openChangeRequests.forPath(openFilePath) : [];
  const { openPr } = usePrViewer();
  const lastCommit = useLastCommit(openFilePath, railOpen);
  // Compare owns the whole column; the rail steps aside for the duration and
  // comes back with the document.
  const railVisible = railOpen && activeTab === 'content';
  const { openFile: navigateToFile } = useFileNav();
  const handleOpenLink = useCallback(
    (href: string) => {
      if (!openFilePath) return;
      navigateToFile(resolveRelativePath(openFilePath, href));
    },
    [openFilePath, navigateToFile],
  );


  if (!openFilePath || openFileContent === null || !Renderer) {
    return (
      <div className="h-full w-full flex flex-col bg-white min-w-0 relative">
        <PullNeededBanner />
        <EditorTabs />
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="max-w-md text-center">
            <h2 className="mb-2 text-head text-ink">
              Open a file, or ask the process assistant a question.
            </h2>
            <p className="mb-6 text-ui text-ink-muted">
              Pick anything from the file tree, or start with a suggestion.
            </p>
            {/* Suggested prompts seed the chat composer — only rendered when a
                chat surface registered the seed port. */}
            {seedSuggestedPrompt && (
              <div className="flex flex-col gap-2">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <Surface
                    key={prompt}
                    as="button"
                    tone="sunken"
                    radius="lg"
                    elevation="none"
                    interactive
                    type="button"
                    onClick={() => seedSuggestedPrompt(prompt)}
                    className="px-3 py-2 text-left text-ui text-ink"
                  >
                    {prompt}
                  </Surface>
                ))}
              </div>
            )}
          </div>
        </div>
        {registeredPanels}
        <PrViewer />
      </div>
    );
  }

  // Which shape the document column takes. A history / comparison panel is a
  // fixed-height viewport with its own scroller (both roots are
  // `flex-1 flex flex-col min-h-0`), so it gets the full-bleed contract for
  // the same reason a PDF does — an auto-height column would collapse it.
  const shellVariant =
    activeTab === 'content' ? getRendererLayout(openFilePath) : 'full-bleed';

  return (
    <div className="h-full w-full flex flex-col bg-white min-w-0 relative">
      <PullNeededBanner />
      {accessRestricted && openFilePath && (
        <AccessRestrictedBanner path={openFilePath} eligible={access.eligible} />
      )}
      {/* ONE column holds the tabs, the title and the text at the same width,
          so they share an edge and the page reads as a single centred block
          (proto:700-705). `editorContainerRef` goes to `scrollRef` because the
          shell is now the element that scrolls — the capture-phase listener
          bound to it is the file lock's only activity signal for a reader. */}
      <KbDocumentShell
              roomy={explorerHidden}
        variant={shellVariant}
        scrollRef={editorContainerRef}
        railLabelledBy={KB_FILE_RAIL_HEADING_ID}
        rail={
          railVisible ? (
            <KbFileRail
              path={openFilePath}
              // Null for a binary file. The workspace loads every open file's
              // content as a string, so `.length` is a number for a PDF too —
              // it just is not a number that means anything.
              charCount={isBinaryFile(openFilePath) ? null : openFileContent?.length ?? null}
              lastCommit={lastCommit}
              owners={access.owners}
              linksOut={linksOut}
              onOpen={handleOpenLink}
            />
          ) : undefined
        }
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
        lockedBy={fileLock.externalLock?.holderName ?? null}
        railOpen={railOpen}
        historyAvailable={historyAvailable}
        isDirty={isManualDirty}
        waitingOnAgentUpdate={waitingOnAgentUpdate}
        isReviewingPending={isReviewingPending}
        activeTab={activeTab}
        onEdit={handleEnterEditMode}
        onDone={handleExitEditMode}
        onToggleRail={() => setRailOpen((v) => !v)}
        onOpenHistory={() => setActiveTab('history')}
        onOpenCompare={() => setActiveTab('compare')}
        onShare={handleShare}
        onCopyPage={canCopyPage ? handleCopyPage : undefined}
        onCopyLink={handleCopyLink}
        onViewRaw={handleViewRaw}
      />

      {/* Content stopped being a tab: the document IS the page, and history
          and comparison are two things you can go and look at. Each renders in
          place of the body with an explicit way back — without it the only
          route home would be reopening the file. */}
      {activeTab === 'history' && historyAvailable ? (
        <>
          <BackToDocument onBack={() => setActiveTab('content')} label="Version history" />
          <FileHistoryPanel
            filePath={openFilePath}
            onRevertCompleted={handleRevertCompleted}
          />
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
          {/* Somebody has proposed a change to this file. It says so here
              whoever opened it — the signal comes from the broad endpoint, not
              from the dock's you-scoped queue, so a colleague's request on a
              file you can read but not write still shows. */}
          {requestsOnThisFile.length > 0 && (
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
                  onClick={() => openPr(requestsOnThisFile[0].number)}
                >
                  Review the change
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
          {/* Accept / Reject banner — hidden whenever a multi-file review
              session exists, so the two review UIs never compete (regardless
              of whether the multi-file panel is currently open). */}
          {isReviewingPending && !hasPendingReview && (
            <Banner
              role="status"
              tone="neutral"
              aria-live="polite"
              aria-atomic="true"
              className="mb-4 flex-none"
            >
              <div className="flex items-center gap-2">
                <span className="flex-1">
                  Previewing agent's changes — accept to keep, reject to undo
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

          {/* Review-action failure banner. Rejecting an agent change is
              optimistic — the row leaves the panel immediately — so a
              background commit/push failure would otherwise be silent. This
              surfaces it (and survives the review panel optimistically
              unmounting on a failed "Reject all"). */}
          {review.lastError && (
            <Banner
              role="alert"
              tone="danger"
              icon={<AlertTriangle size={14} />}
              aria-live="assertive"
              className="mb-4 flex-none"
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 font-medium">{review.lastError}</span>
                <Button variant="quiet" size="sm" title="Dismiss" onClick={() => review.clearError()}>
                  Dismiss
                </Button>
              </div>
            </Banner>
          )}

          {/* File content — show pending (new) content when reviewing, accepted content otherwise.
              Lock semantics: the editor is read-only whenever we're not in
              explicit Edit mode. Edit mode is gated by the lock, so this
              also covers "someone else holds it" without a separate check.
              The scroll-activity source for the idle-release timer is the
              shell above, not this wrapper — see `KbDocumentShell.scrollRef`. */}
          <div className={shellVariant === 'full-bleed' ? 'flex min-h-0 flex-1 flex-col' : 'min-w-0'}>
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
              key={editMode ? `${openFilePath}|edit` : `${openFilePath}|${openFileSavedContent?.length ?? 0}|${openFileSavedContent?.slice(0, 64) ?? ''}|${openFileSavedContent?.slice(-64) ?? ''}`}
              content={isReviewingPending ? pendingFileContent! : openFileContent}
              savedContent={isReviewingPending ? pendingFileContent! : (openFileSavedContent ?? openFileContent)}
              filePath={openFilePath}
              onSave={isReviewingPending || onProtectedBranch ? handlePendingSave : handleSave}
              onDirtyChange={setIsManualDirty}
              onValueChange={isReviewingPending || onProtectedBranch || !editMode ? undefined : handleValueChange}
              onSaveStateChange={setManualSaveState}
              readOnly={isReviewingPending || onProtectedBranch || !editMode}
            />
          </div>
        </>
      )}
      </KbDocumentShell>
      {registeredPanels}
      <PrViewer />
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
