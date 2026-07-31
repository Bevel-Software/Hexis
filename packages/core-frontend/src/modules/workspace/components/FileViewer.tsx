import { useMemo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, XCircle, FileText, History, Clock4, GitCompare, Link2, Lock, Pencil, AlertTriangle } from 'lucide-react';
import { useWorkspace } from '../state/workspace.context';
import { EditorTabs } from './EditorTabs';
import { useGit } from '../../git/state/git.context';
import { useCanonicalFileUrl } from '../routing/kb-routes';
import { useReview } from '../../review/state/review.context';
import { ProtectedBranchBanner } from '../../git/components/ProtectedBranchBanner';
import { PullNeededBanner } from '../../git/components/PullNeededBanner';
import { useFileAccess } from '../../access/hooks/useFileAccess';
import { AccessRestrictedBanner } from '../../access/components/AccessRestrictedBanner';
import { NodeOwnersBanner } from '../../access/components/NodeOwnersBanner';
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
import { getFileRenderer } from './renderers';
import type { RendererSaveState } from './renderers';

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
  const [linkCopied, setLinkCopied] = useState(false);
  // Chat decoupling: the suggested-prompt seed is an optional registry port
  // (null when no chat surface is registered → the prompt buttons hide).
  const seedSuggestedPrompt = useSuggestedPromptSeed();
  const { fileViewerPanels, renderers } = useAppRegistry();
  const git = useGit();
  const review = useReview();

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
  // which acquires. Idle for 30s? `useFileLock` auto-releases and
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
  //     or 30s idle (the hook's idle timer).
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
  const handleCopyLink = useCallback(async () => {
    try {
      const base = canonicalFileUrl ?? `${window.location.origin}${window.location.pathname}`;
      await navigator.clipboard.writeText(base + window.location.hash);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy link:', err);
    }
  }, [canonicalFileUrl]);


  if (!openFilePath || openFileContent === null || !Renderer) {
    return (
      <div className="h-full w-full flex flex-col bg-white min-w-0 relative">
        <ProtectedBranchBanner />
        <PullNeededBanner />
        <EditorTabs />
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="max-w-md text-center">
            <h2 className="text-ink text-base font-medium tracking-tight mb-2">
              Open a file, or ask the process assistant a question.
            </h2>
            <p className="text-ink-muted text-sm mb-6">
              Pick anything from the file tree, or start with a suggestion.
            </p>
            {/* Suggested prompts seed the chat composer — only rendered when a
                chat surface registered the seed port. */}
            {seedSuggestedPrompt && (
              <div className="flex flex-col gap-2">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => seedSuggestedPrompt(prompt)}
                    className="text-left text-sm text-ink bg-sunken hover:bg-hover border border-line hover:border-line-strong rounded-lg px-3 py-2 transition-colors duration-150"
                  >
                    {prompt}
                  </button>
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

  const lastSlash = openFilePath.lastIndexOf('/');
  const fileName = lastSlash >= 0 ? openFilePath.slice(lastSlash + 1) : openFilePath;
  const parentDir = lastSlash >= 0 ? openFilePath.slice(0, lastSlash) : '';

  return (
    <div className="h-full w-full flex flex-col bg-white min-w-0 relative">
      <ProtectedBranchBanner />
      <PullNeededBanner />
      {accessRestricted && openFilePath && (
        <AccessRestrictedBanner path={openFilePath} eligible={access.eligible} />
      )}
      {openFilePath && <NodeOwnersBanner owners={access.owners} />}
      <EditorTabs />
      {/* Active-file metadata + sub-tabs (Content / History / Compare) */}
      <div className="h-10 border-b border-line flex items-center px-3 gap-2 shrink-0">
        <span className="text-sm font-medium tracking-tight text-ink truncate shrink-0">
          {fileName}
        </span>
        {parentDir && (
          <span className="text-xs text-ink-muted truncate min-w-0">
            {parentDir}
          </span>
        )}
        {isManualDirty && (
          <span className="ml-1 inline-flex items-center gap-1 text-xs text-amber-700 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            Unsaved
          </span>
        )}
        {waitingOnAgentUpdate && (
          <span className="ml-1 inline-flex items-center gap-1 text-xs text-amber-700 font-medium">
            <Clock4 size={12} />
            Agent update waiting
          </span>
        )}
        {isReviewingPending && (
          <span className="ml-1 inline-flex items-center gap-1 text-xs text-emerald-600 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Reviewing agent update
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <TabButton
            active={activeTab === 'content'}
            onClick={() => setActiveTab('content')}
            icon={<FileText size={12} />}
            label="Content"
          />
          {historyAvailable && (
            <TabButton
              active={activeTab === 'history'}
              onClick={() => setActiveTab('history')}
              icon={<History size={12} />}
              label="History"
            />
          )}
          {historyAvailable && (
            <TabButton
              active={activeTab === 'compare'}
              onClick={() => setActiveTab('compare')}
              icon={<GitCompare size={12} />}
              label="Compare"
            />
          )}
          <button
            onClick={handleCopyLink}
            className="ml-1 p-1 rounded hover:bg-hover text-ink-muted hover:text-ink transition-colors duration-150 relative"
            title={linkCopied ? 'Link copied' : 'Copy link to this file'}
            aria-label="Copy link to this file"
          >
            <Link2 size={14} />
            {linkCopied && (
              <span className="absolute top-full right-0 mt-1 px-1.5 py-0.5 rounded bg-ink text-[10px] text-emerald-300 whitespace-nowrap pointer-events-none">
                Link copied
              </span>
            )}
          </button>
          {/* Edit / Save toggle. Hidden on protected branches (read-only)
              and while reviewing a pending agent update (the Accept/Reject
              banner owns the workflow there). Disabled when someone else
              holds the lock — the existing lock banner explains who. Both
              states use the same emerald palette so the toolbar reads as
              "one action button changing its label" rather than two
              competing controls. */}
          {!onProtectedBranch && !isReviewingPending && activeTab === 'content' && (
            editMode ? (
              <button
                onClick={handleExitEditMode}
                className="ml-1 flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-emerald-700 text-white hover:bg-emerald-600 transition-colors"
                title="Save changes and return to view mode"
              >
                <Check size={12} />
                Save
              </button>
            ) : (
              <button
                onClick={handleEnterEditMode}
                disabled={!!fileLock.externalLock || isEnteringEdit}
                className="ml-1 flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-emerald-700 text-white hover:bg-emerald-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title={
                  fileLock.externalLock
                    ? `Locked by ${fileLock.externalLock.holderName}`
                    : isEnteringEdit
                      ? 'Acquiring lock and fetching latest content…'
                      : 'Click to edit this file'
                }
              >
                <Pencil size={12} />
                {isEnteringEdit ? 'Loading…' : 'Edit'}
              </button>
            )
          )}
        </div>
      </div>

      {activeTab === 'history' && historyAvailable ? (
        <FileHistoryPanel
          filePath={openFilePath}
          onRevertCompleted={handleRevertCompleted}
        />
      ) : activeTab === 'compare' && historyAvailable ? (
        <FileComparisonPanel
          filePath={openFilePath}
          initialFrom={comparisonOverride?.fromBranch ?? null}
          initialTo={comparisonOverride?.toBranch ?? null}
          refreshKey={fsRevision}
        />
      ) : (
        <>
          {waitingOnAgentUpdate && (
            <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-2 px-3 py-2 bg-amber-50 border-b border-amber-200 shrink-0">
              <span className="text-xs text-amber-800 flex-1">
                Agent update is waiting. Save or undo your unsaved edits before reviewing it.
              </span>
              <button
                onClick={handleReviewAgentUpdate}
                disabled={isManualDirty}
                className="px-2.5 py-1 rounded text-xs font-medium bg-amber-700 hover:bg-amber-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title={isManualDirty ? 'Finish local edits first' : 'Open the agent update preview'}
              >
                Review agent update
              </button>
            </div>
          )}
          {/* Accept / Reject banner — hidden whenever a multi-file review
              session exists, so the two review UIs never compete (regardless
              of whether the multi-file panel is currently open). */}
          {isReviewingPending && !hasPendingReview && (
        <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-2 px-3 py-2 bg-sunken border-b border-line-strong shrink-0">
          <span className="text-xs text-ink flex-1">
            Previewing agent's changes — accept to keep, reject to undo
          </span>
          <button
            onClick={handleReject}
            disabled={isSubmitting}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-ink-muted hover:text-ink hover:bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <XCircle size={13} />
            Reject
          </button>
          <button
            onClick={handleAccept}
            disabled={isSubmitting}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-emerald-700 hover:bg-emerald-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Check size={13} />
            Accept
          </button>
        </div>
          )}

          {/* Lock-by-someone-else banner — read-only state until the holder releases. */}
          {fileLock.externalLock && !fileLock.holdingLock && !isReviewingPending && !onProtectedBranch && (
            <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-2 px-3 py-2 bg-amber-50 border-b border-amber-200 shrink-0">
              <Lock size={14} className="text-amber-700 shrink-0" />
              <span className="text-xs text-amber-800 flex-1">
                Locked by <span className="font-medium">{fileLock.externalLock.holderName}</span>. The editor is read-only until they finish.
              </span>
            </div>
          )}

          {/* Save-failure banner. Validator failures carry a structured
              `mustFix` list which we render so the user can see which KB
              issues are blocking the commit (the validator gates ALL
              commits, even unrelated edits — without this UI the failure
              looks silent and the user keeps clicking Save). */}
          {saveError && (
            <div role="alert" aria-live="assertive" className="flex flex-col gap-2 px-3 py-2 bg-red-50 border-b border-red-200 shrink-0">
              <div className="flex items-center gap-2">
                <AlertTriangle size={14} className="text-red-700 shrink-0" />
                <span className="text-xs text-red-800 flex-1 font-medium">{saveError.message}</span>
                <button
                  type="button"
                  onClick={() => setSaveError(null)}
                  className="text-red-700 hover:text-red-900 text-xs underline"
                  title="Dismiss"
                >
                  Dismiss
                </button>
              </div>
              {saveError.kind === 'validation' && saveError.mustFix.length > 0 && (
                <ul className="text-xs text-red-800 ml-6 list-disc space-y-0.5 max-h-32 overflow-y-auto">
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
            </div>
          )}

          {/* Review-action failure banner. Rejecting an agent change is
              optimistic — the row leaves the panel immediately — so a
              background commit/push failure would otherwise be silent. This
              surfaces it (and survives the review panel optimistically
              unmounting on a failed "Reject all"). */}
          {review.lastError && (
            <div role="alert" aria-live="assertive" className="flex items-center gap-2 px-3 py-2 bg-red-50 border-b border-red-200 shrink-0">
              <AlertTriangle size={14} className="text-red-700 shrink-0" />
              <span className="text-xs text-red-800 flex-1 font-medium">{review.lastError}</span>
              <button
                type="button"
                onClick={() => review.clearError()}
                className="text-red-700 hover:text-red-900 text-xs underline"
                title="Dismiss"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* File content — show pending (new) content when reviewing, accepted content otherwise.
              Lock semantics: the editor is read-only whenever we're not in
              explicit Edit mode. Edit mode is gated by the lock, so this
              also covers "someone else holds it" without a separate check.
              `editorContainerRef` is the scroll-activity source for the
              idle-release timer. */}
          <div ref={editorContainerRef} className="flex-1 overflow-hidden p-4">
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
      {registeredPanels}
      <PrViewer />
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick(): void;
  icon: ReactNode;
  label: string;
}

function TabButton({ active, onClick, icon, label }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
        active
          ? 'bg-sunken text-ink'
          : 'text-ink-muted hover:text-ink hover:bg-hover'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
